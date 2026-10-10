import { and, eq, inArray, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { CANCELLABLE_STATUSES, readinessBlockers, WITHDRAWABLE_STATUSES } from "@/domain/funding";
import { chooseOrganizer, isOfferOpen, rankReplacements } from "@/domain/matching";
import { allocateByQuantity } from "@/domain/money";
import type { MatchShopper } from "@/domain/types";
import { getDb, type Tx } from "@/server/db/client";
import { allocations, bankOperations, groups, needs, shoppers } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import {
  type ActionContext,
  advanceGroup,
  bumpGroupVersion,
  dispatchOperation,
  ensureCollectionAccount,
  prepareOperation,
  setGroupStatus,
} from "@/server/services/funding-service";
import {
  currentMembers,
  type GroupBundle,
  loadBundleFor,
  loadGroupBundle,
  operationById,
  toFundingAllocations,
  vacantAllocations,
} from "@/server/services/group-view";
import {
  appendGroupEvent,
  assertVersion,
  enqueueGroup,
  enqueueNeed,
  enqueueOperation,
  lockGroup,
  toMatchNeed,
  toOfferTerms,
} from "@/server/services/records";
import { syncSession } from "@/server/services/sync-service";

async function lockedBundle(tx: Tx, ctx: ActionContext, groupId: string, expectedVersion: number) {
  const group = await lockGroup(tx, ctx.session.id, groupId);
  assertVersion(group, expectedVersion);
  return loadBundleFor(tx, group);
}

function memberAllocation(bundle: GroupBundle, shopperId: string) {
  const allocation = bundle.allocations.find(
    (row) => row.shopperId === shopperId && row.state === "active",
  );
  if (!allocation)
    throw new DomainError("NOT_AUTHORIZED", "You are not an active member of this group.");
  return allocation;
}

function requireOrganizer(bundle: GroupBundle, ctx: ActionContext) {
  if (ctx.demoControl) return;
  const organizer = bundle.group.organizerShopperId;
  if (organizer === ctx.shopperId) return;
  const member = bundle.allocations.find(
    (row) => row.shopperId === ctx.shopperId && row.state === "active" && row.consent !== null,
  );
  if (organizer === null && member) return;
  throw new DomainError("NOT_AUTHORIZED", "Only the group organizer can do that.");
}

function offerValid(bundle: GroupBundle): boolean {
  return (
    isOfferOpen(toOfferTerms(bundle.offer), runtime.now()) &&
    bundle.offer.version === bundle.group.offerSnapshot.version
  );
}

async function memberShoppers(tx: Tx, bundle: GroupBundle): Promise<Map<string, MatchShopper>> {
  const ids = currentMembers(bundle.allocations).map((row) => row.shopperId);
  const rows = ids.length ? await tx.select().from(shoppers).where(inArray(shoppers.id, ids)) : [];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        displayName: row.displayName,
        memberships: row.memberships,
        availableCents: null,
      },
    ]),
  );
}

async function memberNeeds(tx: Tx, bundle: GroupBundle) {
  const ids = currentMembers(bundle.allocations).map((row) => row.needId);
  return ids.length ? tx.select().from(needs).where(inArray(needs.id, ids)).for("update") : [];
}

/**
 * Confirm the actor's exact terms. The first confirmation reserves every need in the proposal
 * atomically; funding starts once all current members consent and the offer is unchanged.
 */
export async function confirmTerms(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
) {
  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    const bundle = await lockedBundle(tx, ctx, groupId, expectedVersion);
    const { group } = bundle;
    const allocation = memberAllocation(bundle, ctx.shopperId);
    if (allocation.consent) return { status: group.status, changed: false };

    const isReplacement = allocation.replacesAllocationId !== null;
    if (
      !(
        group.status === "awaiting_confirmation" ||
        (group.status === "replacement_needed" && isReplacement)
      )
    ) {
      throw new DomainError("INCOMPATIBLE_STATE", "These terms can no longer be confirmed.");
    }
    if (!offerValid(bundle)) {
      if (group.status === "awaiting_confirmation") {
        await setGroupStatus(tx, bundle, "cancelled", "system", "offer_changed");
        await enqueueGroup(tx, bundle.group, bundle.allocations);
        return { status: "cancelled" as const, changed: true, offerChanged: true };
      }
      throw new DomainError(
        "OFFER_CHANGED",
        "The offer changed, so these terms cannot be confirmed.",
      );
    }

    const needRows = await memberNeeds(tx, bundle);
    const needById = new Map(needRows.map((row) => [row.id, row]));
    const ownNeed = needById.get(allocation.needId);
    if (!ownNeed) throw new DomainError("NEED_UNAVAILABLE", "Your request is no longer available.");
    if (allocation.contributionCents > ownNeed.maxContributionCents) {
      throw new DomainError("STALE_PROPOSAL", "Your share is above your contribution limit.");
    }

    if (group.status === "awaiting_confirmation") {
      const firstConfirmation = bundle.allocations.every((row) => row.consent === null);
      if (firstConfirmation) {
        // Recalculate the same allocation from current Postgres records before reserving.
        const members = currentMembers(bundle.allocations);
        const shares = allocateByQuantity(
          bundle.offer.totalCents,
          members.map((row) => ({
            id: row.needId,
            quantity: needById.get(row.needId)?.quantity ?? 0,
          })),
        );
        for (const member of members) {
          const need = needById.get(member.needId);
          const share = shares.get(member.needId);
          if (
            need?.status !== "forming" ||
            need.quantity !== member.quantity ||
            share !== member.contributionCents ||
            member.contributionCents > need.maxContributionCents
          ) {
            await setGroupStatus(tx, bundle, "cancelled", "system", "stale_proposal");
            await enqueueGroup(tx, bundle.group, bundle.allocations);
            return { status: "cancelled" as const, changed: true, stale: true };
          }
        }
        const reserved = await tx
          .update(needs)
          .set({
            status: "reserved",
            reservedGroupId: group.id,
            revision: sql`${needs.revision} + 1`,
            updatedAt: runtime.now(),
          })
          .where(
            and(
              inArray(
                needs.id,
                members.map((row) => row.needId),
              ),
              eq(needs.status, "forming"),
            ),
          )
          .returning();
        if (reserved.length !== members.length) {
          throw new DomainError(
            "NEED_UNAVAILABLE",
            "Someone in this proposal already joined another group.",
          );
        }
        for (const need of reserved) await enqueueNeed(tx, need);
      } else if (ownNeed.reservedGroupId !== group.id) {
        throw new DomainError(
          "NEED_UNAVAILABLE",
          "Your request is no longer reserved for this group.",
        );
      }
    } else {
      // Replacement: reserve only the replacement's own need.
      const [reserved] = await tx
        .update(needs)
        .set({
          status: "reserved",
          reservedGroupId: group.id,
          revision: sql`${needs.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(needs.id, ownNeed.id), eq(needs.status, "forming")))
        .returning();
      if (!reserved)
        throw new DomainError("NEED_UNAVAILABLE", "Your request is no longer available.");
      await enqueueNeed(tx, reserved);
    }

    await tx
      .update(allocations)
      .set({
        consent: {
          offerId: bundle.offer.id,
          offerVersion: bundle.offer.version,
          quantity: allocation.quantity,
          contributionCents: allocation.contributionCents,
          pickupZone: group.pickupZone,
          pickupWindow: group.pickupWindow,
          consentedAt: runtime.now().toISOString(),
        },
        updatedAt: runtime.now(),
      })
      .where(eq(allocations.id, allocation.id));
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "terms_confirmed",
      payload: {
        allocationId: allocation.id,
        quantity: allocation.quantity,
        contributionCents: allocation.contributionCents,
        replacement: isReplacement,
      },
    });

    let next = await loadBundleFor(tx, bundle.group);
    if (!next.group.organizerShopperId) {
      const shopperMap = await memberShoppers(tx, next);
      const organizer = chooseOrganizer(
        currentMembers(next.allocations).map((row) => {
          const need = needById.get(row.needId) ?? ownNeed;
          return toMatchNeed(need);
        }),
        toOfferTerms(next.offer),
        shopperMap,
        null,
      );
      if (organizer) {
        await tx
          .update(groups)
          .set({ organizerShopperId: organizer })
          .where(eq(groups.id, groupId));
        await appendGroupEvent(tx, {
          sessionId: ctx.session.id,
          groupId,
          actor: "system",
          type: "organizer_assigned",
          payload: { shopperId: organizer },
        });
        next = await loadBundleFor(tx, { ...next.group, organizerShopperId: organizer });
      }
    }
    const everyoneConsented = currentMembers(next.allocations).every((row) => row.consent !== null);
    const vacancies = vacantAllocations(next.allocations).length;
    if (everyoneConsented && vacancies === 0 && next.group.organizerShopperId) {
      await setGroupStatus(tx, next, "funding", ctx.actor);
    } else {
      await bumpGroupVersion(tx, next);
    }
    next = await loadBundleFor(tx, next.group);
    await enqueueGroup(tx, next.group, next.allocations);
    return { status: next.group.status, changed: true };
  });

  if ("offerChanged" in outcome && outcome.offerChanged) {
    throw new DomainError("OFFER_CHANGED", "The offer changed, so this proposal was cancelled.");
  }
  if ("stale" in outcome && outcome.stale) {
    throw new DomainError(
      "STALE_PROPOSAL",
      "This proposal is out of date. Search again for a group.",
    );
  }
  if (outcome.status === "funding") {
    await ensureCollectionAccount(providers, ctx.session, groupId);
    await advanceGroup(providers, ctx.session, groupId);
  }
}

/**
 * Leave the group before purchase. A confirmed contribution is returned in full through a new
 * transfer; an unresolved one is reconciled first. Existing members keep their terms.
 */
export async function withdraw(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const bundle = await lockedBundle(tx, ctx, groupId, expectedVersion);
    const { group } = bundle;
    if (!WITHDRAWABLE_STATUSES.has(group.status)) {
      throw new DomainError(
        "INCOMPATIBLE_STATE",
        group.status === "purchasing"
          ? "The purchase is already being recorded, so you can no longer leave."
          : "You can no longer leave this group.",
      );
    }
    const allocation = memberAllocation(bundle, ctx.shopperId);

    const [withdrawn] = await tx
      .update(needs)
      .set({
        status: "withdrawn",
        reservedGroupId: null,
        revision: sql`${needs.revision} + 1`,
        updatedAt: runtime.now(),
      })
      .where(eq(needs.id, allocation.needId))
      .returning();
    if (withdrawn) await enqueueNeed(tx, withdrawn);

    if (group.status === "awaiting_confirmation") {
      await tx
        .update(allocations)
        .set({ state: "departed", departedAt: runtime.now(), updatedAt: runtime.now() })
        .where(eq(allocations.id, allocation.id));
      const released = await tx
        .update(needs)
        .set({
          status: "forming",
          reservedGroupId: null,
          revision: sql`${needs.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(needs.reservedGroupId, group.id), eq(needs.status, "reserved")))
        .returning();
      for (const need of released) await enqueueNeed(tx, need);
      await appendGroupEvent(tx, {
        sessionId: ctx.session.id,
        groupId,
        actor: ctx.actor,
        type: "member_withdrew",
        payload: { allocationId: allocation.id, funded: false },
      });
      await setGroupStatus(tx, bundle, "cancelled", ctx.actor, "member_withdrew_before_funding");
      const next = await loadBundleFor(tx, bundle.group);
      await enqueueGroup(tx, next.group, next.allocations);
      return;
    }

    const contribution = operationById(bundle, allocation.contributionOperationId);
    let state: "departing" | "departed" = "departing";
    if (!contribution || contribution.status === "failed") state = "departed";
    else if (contribution.status === "prepared") {
      const [abandoned] = await tx
        .update(bankOperations)
        .set({
          status: "failed",
          lastError: { code: "CANCELLED_BEFORE_DISPATCH", message: "Member left before sending" },
          revision: sql`${bankOperations.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(bankOperations.id, contribution.id), eq(bankOperations.status, "prepared")))
        .returning();
      if (abandoned) {
        await enqueueOperation(tx, abandoned);
        state = "departed";
      }
    } else if (contribution.status === "confirmed") {
      if (!group.collectionAccountRef) throw new Error("Collection account missing");
      const returned = await prepareOperation(tx, {
        sessionId: ctx.session.id,
        groupId,
        allocationId: allocation.id,
        kind: "return",
        operationKey: `return:${allocation.id}`,
        amountCents: contribution.amountCents,
        fromAccountRef: group.collectionAccountRef,
        toRef: contribution.fromAccountRef,
        relatedOperationId: contribution.id,
      });
      await tx
        .update(allocations)
        .set({ returnOperationId: returned.id })
        .where(eq(allocations.id, allocation.id));
    }
    await tx
      .update(allocations)
      .set({
        state,
        departedAt: state === "departed" ? runtime.now() : null,
        updatedAt: runtime.now(),
      })
      .where(eq(allocations.id, allocation.id));
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "member_withdrew",
      payload: {
        allocationId: allocation.id,
        contributionStatus: contribution?.status ?? null,
        returnRequired: contribution?.status === "confirmed",
      },
    });

    let next = await loadBundleFor(tx, bundle.group);
    if (group.organizerShopperId === ctx.shopperId) {
      const remaining = currentMembers(next.allocations);
      const needRows = remaining.length
        ? await tx
            .select()
            .from(needs)
            .where(
              inArray(
                needs.id,
                remaining.map((row) => row.needId),
              ),
            )
        : [];
      const organizer = chooseOrganizer(
        needRows.map(toMatchNeed),
        toOfferTerms(next.offer),
        await memberShoppers(tx, next),
        null,
      );
      await tx.update(groups).set({ organizerShopperId: organizer }).where(eq(groups.id, groupId));
      await appendGroupEvent(tx, {
        sessionId: ctx.session.id,
        groupId,
        actor: "system",
        type: organizer ? "organizer_assigned" : "organizer_needed",
        payload: { shopperId: organizer },
      });
      next = await loadBundleFor(tx, { ...next.group, organizerShopperId: organizer });
    }
    const departing = next.allocations.some((row) => row.state === "departing");
    await setGroupStatus(
      tx,
      next,
      departing ? "returning_contribution" : "replacement_needed",
      ctx.actor,
      "member_withdrew",
    );
    next = await loadBundleFor(tx, next.group);
    await enqueueGroup(tx, next.group, next.allocations);
  });
  await advanceGroup(providers, ctx.session, groupId);
}

/**
 * Offer the vacated fixed slot to the oldest compatible request whose limit, available funds and
 * own baseline support exactly that share. The replacement must then confirm for themselves.
 */
export async function findReplacement(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
) {
  const db = getDb();
  const bundle = await loadGroupBundle(db, ctx.session.id, groupId);
  assertVersion(bundle.group, expectedVersion);
  if (bundle.group.status !== "replacement_needed") {
    throw new DomainError("INCOMPATIBLE_STATE", "This group is not looking for a replacement.");
  }
  if (!ctx.demoControl) {
    const member = bundle.allocations.find(
      (row) => row.shopperId === ctx.shopperId && row.state === "active" && row.consent !== null,
    );
    if (!member)
      throw new DomainError("NOT_AUTHORIZED", "Only confirmed members can look for a replacement.");
  }
  const pendingReplacement = bundle.allocations.find(
    (row) => row.state === "active" && row.replacesAllocationId !== null && row.consent === null,
  );
  const slot = pendingReplacement ?? vacantAllocations(bundle.allocations)[0];
  if (!slot) throw new DomainError("INCOMPATIBLE_STATE", "There is no open share to fill.");

  await syncSession(ctx.session.id, providers);
  const query = await providers.analytics.queryCandidates({
    sessionId: ctx.session.id,
    offerId: bundle.offer.id,
    initiatingNeedId: slot.needId,
    initiatingShopperId: slot.shopperId,
    pickupZone: bundle.group.pickupZone,
    pickupWindow: bundle.group.pickupWindow,
    limit: 11,
  });
  const rows = query.rows.length
    ? await db
        .select()
        .from(needs)
        .where(
          inArray(
            needs.id,
            query.rows.map((row) => row.needId),
          ),
        )
    : [];
  const versions = new Map(query.rows.map((row) => [row.needId, row.entityVersion]));
  const fresh = rows.filter(
    (row) => row.status === "forming" && versions.get(row.id) === row.revision,
  );
  const candidateShoppers = fresh.length
    ? await db
        .select()
        .from(shoppers)
        .where(
          inArray(
            shoppers.id,
            fresh.map((row) => row.shopperId),
          ),
        )
    : [];
  const shopperMap = new Map<string, MatchShopper>();
  for (const shopper of candidateShoppers) {
    const balance = shopper.fundingAccountRef
      ? await providers.banking.getBalanceCents(shopper.fundingAccountRef)
      : null;
    shopperMap.set(shopper.id, {
      id: shopper.id,
      displayName: shopper.displayName,
      memberships: shopper.memberships,
      availableCents: balance === null ? null : balance - shopper.bufferCents,
    });
  }
  const ranked = rankReplacements({
    slot: { quantity: slot.quantity, contributionCents: slot.contributionCents },
    offer: toOfferTerms(bundle.offer),
    pickupZone: bundle.group.pickupZone,
    pickupWindow: bundle.group.pickupWindow,
    candidates: fresh.map(toMatchNeed),
    shoppers: shopperMap,
    excludedNeedIds: new Set(bundle.allocations.map((row) => row.needId)),
    excludedShopperIds: new Set(bundle.allocations.map((row) => row.shopperId)),
  });
  const choice = ranked[0];
  if (!choice) {
    await db.transaction(async (tx) => {
      await lockGroup(tx, ctx.session.id, groupId);
      await appendGroupEvent(tx, {
        sessionId: ctx.session.id,
        groupId,
        actor: ctx.actor,
        type: "no_replacement_found",
        payload: { candidates: query.rows.length },
      });
    });
    throw new DomainError(
      "NO_REPLACEMENT",
      "Nobody nearby can take this exact share right now. You can keep waiting or cancel the group.",
    );
  }

  await db.transaction(async (tx) => {
    const locked = await lockedBundle(tx, ctx, groupId, expectedVersion);
    if (locked.group.status !== "replacement_needed") {
      throw new DomainError("INCOMPATIBLE_STATE", "This group is not looking for a replacement.");
    }
    if (pendingReplacement) {
      // The earlier candidate did not confirm; their slot becomes the vacancy again.
      await tx
        .update(allocations)
        .set({ state: "departed", departedAt: runtime.now(), updatedAt: runtime.now() })
        .where(and(eq(allocations.id, pendingReplacement.id), sql`${allocations.consent} is null`));
    }
    await tx.insert(allocations).values({
      id: runtime.newId("alc"),
      position: Math.max(...locked.allocations.map((row) => row.position)) + 1,
      sessionId: ctx.session.id,
      groupId,
      needId: choice.need.id,
      shopperId: choice.need.shopperId,
      quantity: slot.quantity,
      contributionCents: slot.contributionCents,
      baselineCents: choice.baselineCents,
      savingsCents: choice.savingsCents,
      state: "active",
      consent: null,
      replacesAllocationId: slot.id,
      createdAt: runtime.now(),
      updatedAt: runtime.now(),
    });
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "replacement_proposed",
      payload: {
        needId: choice.need.id,
        shopperId: choice.need.shopperId,
        quantity: slot.quantity,
        contributionCents: slot.contributionCents,
        queryId: query.queryId,
      },
    });
    await bumpGroupVersion(tx, locked);
    const next = await loadBundleFor(tx, locked.group);
    await enqueueGroup(tx, next.group, next.allocations);
  });
  return { shopperId: choice.need.shopperId };
}

/** Cancel before purchase. Unfunded groups cancel immediately; funded ones return every contribution. */
export async function cancelGroup(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
  reason = "cancelled_by_organizer",
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const bundle = await lockedBundle(tx, ctx, groupId, expectedVersion);
    requireOrganizer(bundle, ctx);
    if (!CANCELLABLE_STATUSES.has(bundle.group.status)) {
      throw new DomainError("INCOMPATIBLE_STATE", "This group can no longer be cancelled.");
    }
    const anyMoney = bundle.operations.some(
      (row) => row.kind === "contribution" && row.status !== "failed" && row.status !== "prepared",
    );
    for (const operation of bundle.operations) {
      if (operation.kind !== "contribution" || operation.status !== "prepared") continue;
      const [abandoned] = await tx
        .update(bankOperations)
        .set({
          status: "failed",
          lastError: {
            code: "CANCELLED_BEFORE_DISPATCH",
            message: "Group cancelled before sending",
          },
          revision: sql`${bankOperations.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(bankOperations.id, operation.id), eq(bankOperations.status, "prepared")))
        .returning();
      if (abandoned) await enqueueOperation(tx, abandoned);
    }
    if (!anyMoney) {
      const released = await tx
        .update(needs)
        .set({
          status: "forming",
          reservedGroupId: null,
          revision: sql`${needs.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(needs.reservedGroupId, groupId), eq(needs.status, "reserved")))
        .returning();
      for (const need of released) await enqueueNeed(tx, need);
      await setGroupStatus(tx, bundle, "cancelled", ctx.actor, reason);
    } else {
      await setGroupStatus(tx, bundle, "cancelling", ctx.actor, reason);
    }
    const next = await loadBundleFor(tx, bundle.group);
    await enqueueGroup(tx, next.group, next.allocations);
  });
  await advanceGroup(providers, ctx.session, groupId);
}

/**
 * Organizer records the simulated merchant purchase. `purchasing` is claimed under the group lock
 * before dispatch, so a concurrent withdrawal is rejected from that point on.
 */
export async function purchase(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
) {
  const db = getDb();
  const preview = await loadGroupBundle(db, ctx.session.id, groupId);
  assertVersion(preview.group, expectedVersion);
  requireOrganizer(preview, ctx);
  if (preview.group.status !== "ready_to_purchase") {
    throw new DomainError("INCOMPATIBLE_STATE", "This group is not ready to purchase.");
  }
  if (!preview.group.collectionAccountRef) throw new Error("Collection account missing");
  const balance = await providers.banking.getBalanceCents(preview.group.collectionAccountRef);
  const merchantRef = ctx.session.merchantRefs[preview.offer.retailer];
  if (!merchantRef)
    throw new DomainError("UPSTREAM_UNAVAILABLE", "Merchant account is not set up.");

  const result = await db.transaction(async (tx) => {
    const bundle = await lockedBundle(tx, ctx, groupId, expectedVersion);
    if (bundle.group.status !== "ready_to_purchase") {
      throw new DomainError("INCOMPATIBLE_STATE", "This group is not ready to purchase.");
    }
    if (!offerValid(bundle)) {
      await setGroupStatus(tx, bundle, "cancelling", ctx.actor, "offer_changed");
      const next = await loadBundleFor(tx, bundle.group);
      await enqueueGroup(tx, next.group, next.allocations);
      return { offerChanged: true as const };
    }
    const blockers = readinessBlockers({
      allocations: toFundingAllocations(bundle),
      totalCents: bundle.group.totalCents,
      collectionBalanceCents: balance,
    });
    if (blockers.length > 0) {
      throw new DomainError("INCOMPATIBLE_STATE", "Funds are not fully reconciled yet.", {
        blockers,
      });
    }
    const operation = await prepareOperation(tx, {
      sessionId: ctx.session.id,
      groupId,
      allocationId: null,
      kind: "purchase",
      operationKey: `purchase:${groupId}`,
      amountCents: bundle.group.totalCents,
      fromAccountRef: bundle.group.collectionAccountRef ?? "",
      toRef: merchantRef,
    });
    if (operation.status === "failed") {
      const [retried] = await tx
        .update(bankOperations)
        .set({
          status: "prepared",
          revision: sql`${bankOperations.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(and(eq(bankOperations.id, operation.id), eq(bankOperations.status, "failed")))
        .returning();
      if (retried) await enqueueOperation(tx, retried);
    }
    await setGroupStatus(tx, bundle, "purchasing", ctx.actor);
    const next = await loadBundleFor(tx, bundle.group);
    await enqueueGroup(tx, next.group, next.allocations);
    return { operationId: operation.id };
  });

  if ("offerChanged" in result) {
    await advanceGroup(providers, ctx.session, groupId);
    throw new DomainError(
      "OFFER_CHANGED",
      "The offer changed before purchase, so the group is cancelling and returning contributions.",
    );
  }
  await dispatchOperation(providers, result.operationId);
  await advanceGroup(providers, ctx.session, groupId);
}

export async function confirmPickup(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const bundle = await lockedBundle(tx, ctx, groupId, expectedVersion);
    if (bundle.group.status !== "purchased") {
      throw new DomainError("INCOMPATIBLE_STATE", "Pickup opens after the purchase is confirmed.");
    }
    const allocation = memberAllocation(bundle, ctx.shopperId);
    await tx
      .update(allocations)
      .set({ state: "picked_up", pickedUpAt: runtime.now(), updatedAt: runtime.now() })
      .where(eq(allocations.id, allocation.id));
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "pickup_confirmed",
      payload: { allocationId: allocation.id, quantity: allocation.quantity },
    });
    await bumpGroupVersion(tx, bundle);
  });
  await advanceGroup(providers, ctx.session, groupId);
}
