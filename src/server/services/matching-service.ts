import { and, eq, inArray } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { findProposals, MAX_OTHER_CANDIDATES } from "@/domain/matching";
import type { MatchShopper } from "@/domain/types";
import { RETAILER_LABELS } from "@/lib/format";
import type { MatchView } from "@/lib/view-types";
import { getDb } from "@/server/db/client";
import {
  type AnalyticsSnapshot,
  allocations,
  groups,
  needs,
  offers,
  shoppers,
} from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import type { ActionContext } from "@/server/services/funding-service";
import { buildGroupView, loadBundleFor } from "@/server/services/group-view";
import {
  appendGroupEvent,
  enqueueGroup,
  toMatchNeed,
  toOfferSnapshot,
  toOfferTerms,
} from "@/server/services/records";
import { syncSession } from "@/server/services/sync-service";

const MAX_PERSISTED_PROPOSALS = 3;

/**
 * Needs-first matching: synchronize analytical inputs, query compatible candidates, revalidate
 * them against Postgres, run the deterministic optimizer and persist ranked proposals.
 */
export async function runMatching(
  providers: Providers,
  ctx: ActionContext,
  needId: string,
): Promise<MatchView> {
  const db = getDb();
  const { session } = ctx;
  const [need] = await db
    .select()
    .from(needs)
    .where(and(eq(needs.id, needId), eq(needs.sessionId, session.id)));
  if (!need) throw new DomainError("NOT_FOUND", "Request not found.");
  if (need.shopperId !== ctx.shopperId) {
    throw new DomainError("NOT_AUTHORIZED", "You can only search for your own request.");
  }
  if (need.status === "reserved") {
    throw new DomainError("NEED_UNAVAILABLE", "This request already belongs to a group.", {
      groupId: need.reservedGroupId,
    });
  }
  if (need.status !== "forming") {
    throw new DomainError("NEED_UNAVAILABLE", "This request is no longer open.");
  }

  const sync = await syncSession(session.id, providers);
  const offerRows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.sessionId, session.id), inArray(offers.id, need.acceptedOfferIds)));

  const queryIds: string[] = [];
  const candidateVersions = new Map<string, number>();
  for (const offer of offerRows) {
    const result = await providers.analytics.queryCandidates({
      sessionId: session.id,
      offerId: offer.id,
      initiatingNeedId: need.id,
      initiatingShopperId: need.shopperId,
      pickupZone: need.pickupZone,
      pickupWindow: need.pickupWindow,
      limit: MAX_OTHER_CANDIDATES,
    });
    if (result.queryId) queryIds.push(result.queryId);
    for (const row of result.rows) candidateVersions.set(row.needId, row.entityVersion);
  }

  // Postgres is authoritative: keep only candidates still open at the analysed revision.
  const candidateRows = candidateVersions.size
    ? await db
        .select()
        .from(needs)
        .where(inArray(needs.id, [...candidateVersions.keys()]))
    : [];
  const fresh = candidateRows.filter(
    (row) => row.status === "forming" && candidateVersions.get(row.id) === row.revision,
  );

  const shopperIds = [...new Set([need.shopperId, ...fresh.map((row) => row.shopperId)])];
  const shopperRows = await db.select().from(shoppers).where(inArray(shoppers.id, shopperIds));
  const shopperMap = new Map<string, MatchShopper>();
  for (const shopper of shopperRows) {
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

  const result = findProposals({
    initiatingNeed: toMatchNeed(need),
    candidateNeeds: fresh.map(toMatchNeed),
    offers: offerRows.map(toOfferTerms),
    shoppers: shopperMap,
    now: runtime.now(),
  });

  const offerById = new Map(offerRows.map((row) => [row.id, row]));
  const snapshotBase = {
    source: providers.analytics.name === "snowflake" ? ("snowflake" as const) : ("local" as const),
    queryId: queryIds[0] ?? null,
    candidateCount: fresh.length,
    syncedThroughOutboxId: sync.deliveredThroughId,
    queriedAt: runtime.now().toISOString(),
  };

  const groupIds = await db.transaction(async (tx) => {
    // Supersede earlier unconfirmed proposals for this same request.
    const previous = await tx
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.sessionId, session.id),
          eq(groups.initiatingNeedId, need.id),
          eq(groups.status, "awaiting_confirmation"),
        ),
      )
      .for("update");
    for (const group of previous) {
      const bundle = await loadBundleFor(tx, group);
      if (bundle.allocations.some((row) => row.consent !== null)) continue;
      const [updated] = await tx
        .update(groups)
        .set({
          status: "cancelled",
          statusReason: "superseded",
          version: group.version + 1,
          updatedAt: runtime.now(),
        })
        .where(eq(groups.id, group.id))
        .returning();
      if (updated) await enqueueGroup(tx, updated, bundle.allocations);
    }

    const ids: string[] = [];
    for (const plan of result.proposals.slice(0, MAX_PERSISTED_PROPOSALS)) {
      const offer = offerById.get(plan.offerId);
      if (!offer) continue;
      const snapshot: AnalyticsSnapshot = {
        ...snapshotBase,
        exclusions: result.exclusions
          .filter((item) => item.offerId === plan.offerId)
          .map(({ needId, shopperId, reason }) => ({ needId, shopperId, reason })),
      };
      const groupId = runtime.newId("grp");
      const [group] = await tx
        .insert(groups)
        .values({
          id: groupId,
          sessionId: session.id,
          offerId: offer.id,
          offerSnapshot: toOfferSnapshot(offer),
          status: "awaiting_confirmation",
          initiatingNeedId: need.id,
          organizerShopperId: plan.organizerShopperId,
          collectionAccountRef: null,
          analyticsSnapshot: snapshot,
          totalCents: plan.totalCents,
          packageQuantity: offer.packageQuantity,
          pickupZone: plan.pickupZone,
          pickupWindow: plan.pickupWindow,
          createdAt: runtime.now(),
          updatedAt: runtime.now(),
        })
        .returning();
      if (!group) throw new Error("Group insert failed");
      const allocationRows = await tx
        .insert(allocations)
        .values(
          plan.allocations.map((allocation, position) => ({
            id: runtime.newId("alc"),
            position,
            sessionId: session.id,
            groupId,
            needId: allocation.needId,
            shopperId: allocation.shopperId,
            quantity: allocation.quantity,
            contributionCents: allocation.contributionCents,
            baselineCents: allocation.baselineCents,
            savingsCents: allocation.savingsCents,
            state: "active" as const,
            createdAt: runtime.now(),
            updatedAt: runtime.now(),
          })),
        )
        .returning();
      if (
        allocationRows.reduce((sum, row) => sum + row.contributionCents, 0) !== offer.totalCents
      ) {
        throw new DomainError(
          "ALLOCATION_INVARIANT",
          "Allocation does not cover the package total.",
        );
      }
      await appendGroupEvent(tx, {
        sessionId: session.id,
        groupId,
        actor: ctx.actor,
        type: "proposal_created",
        payload: {
          members: plan.allocations.length,
          totalSavingsCents: plan.totalSavingsCents,
          analyticsSource: snapshot.source,
          queryId: snapshot.queryId,
        },
      });
      await enqueueGroup(tx, group, allocationRows);
      ids.push(groupId);
    }
    return ids;
  });

  const nameById = new Map(shopperRows.map((row) => [row.id, row.displayName]));
  const groupViews = [];
  for (const groupId of groupIds) {
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    if (group)
      groupViews.push(buildGroupView(session, await loadBundleFor(db, group), ctx.shopperId, null));
  }

  let demand: MatchView["demand"] = [];
  try {
    const summary = await providers.analytics.demandSummary(session.id);
    if (summary.queryId) queryIds.push(summary.queryId);
    const allOffers = await db.select().from(offers).where(eq(offers.sessionId, session.id));
    const labels = new Map(allOffers.map((row) => [row.id, row]));
    demand = summary.rows
      .filter((row) => row.openNeeds > 0)
      .map((row) => {
        const offer = labels.get(row.offerId);
        return {
          ...row,
          productName: offer?.productName ?? row.offerId,
          retailerLabel: offer ? RETAILER_LABELS[offer.retailer] : "",
        };
      });
  } catch {
    demand = [];
  }

  return {
    needId: need.id,
    groups: groupViews,
    exclusions: result.exclusions
      .filter((item) => item.reason !== "not_selected" && item.needId !== need.id)
      .map((item) => ({
        name: nameById.get(item.shopperId) ?? "A nearby shopper",
        offerId: item.offerId,
        reason: item.reason,
        minimumShareCents: item.minimumShareCents,
      }))
      .concat(
        result.exclusions
          .filter((item) => item.needId === need.id)
          .map((item) => ({
            name: "You",
            offerId: item.offerId,
            reason: item.reason,
            minimumShareCents: item.minimumShareCents,
          })),
      ),
    analytics: {
      source: snapshotBase.source,
      queryIds,
      syncedThroughOutboxId: sync.deliveredThroughId,
    },
    demand,
  };
}
