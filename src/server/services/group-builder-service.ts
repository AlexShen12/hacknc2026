import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { isOfferOpen } from "@/domain/matching";
import { formatCents } from "@/domain/money";
import {
  evaluateJoin,
  evaluateSlotJoin,
  finalizeShares,
  JOIN_ISSUE_TEXT,
  type JoinQuote,
} from "@/domain/open-group";
import type { GroupVisibility } from "@/domain/types";
import type { GroupView } from "@/lib/view-types";
import { getDb, type Tx } from "@/server/db/client";
import { allocations, groups, needs, offers } from "@/server/db/schema";
import { databaseLabel } from "@/server/config";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import { spendable } from "@/server/services/balance-service";
import {
  type ActionContext,
  advanceGroup,
  bumpGroupVersion,
  ensureCollectionAccount,
  setGroupStatus,
} from "@/server/services/funding-service";
import {
  buildGroupView,
  currentMembers,
  joinSlotFor,
  loadBundleFor,
  loadGroupBundle,
} from "@/server/services/group-view";
import { notify } from "@/server/services/notification-service";
import {
  appendGroupEvent,
  assertVersion,

  lockGroup,
  type NeedRow,
  toOfferSnapshot,
  toOfferTerms,
} from "@/server/services/records";
import { getShopper, type SessionRow } from "@/server/services/session-service";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newInviteCode(): string {
  return [...randomBytes(8)].map((byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join("");
}

async function availableCents(
  providers: Providers,
  session: SessionRow,
  shopperId: string,
  pickupWindow: string,
) {
  const shopper = await getShopper(session.id, shopperId);
  const money = await spendable(providers, session, shopper, pickupWindow);
  return { shopper, available: money?.spendableCents ?? null };
}

/** Reserve the shopper's open request for this offer, or create one, for the given group. */
async function reserveNeed(
  tx: Tx,
  input: {
    sessionId: string;
    shopperId: string;
    offerId: string;
    pickupZone: string;
    pickupWindow: string;
    quantity: number;
    maxContributionCents: number;
    groupId: string;
  },
): Promise<NeedRow> {
  const [open] = await tx
    .select()
    .from(needs)
    .where(
      and(
        eq(needs.sessionId, input.sessionId),
        eq(needs.shopperId, input.shopperId),
        eq(needs.status, "forming"),
        sql`${needs.acceptedOfferIds} @> ${JSON.stringify([input.offerId])}::jsonb`,
      ),
    )
    .for("update");
  let row: NeedRow | undefined;
  if (open) {
    [row] = await tx
      .update(needs)
      .set({
        status: "reserved",
        reservedGroupId: input.groupId,
        quantity: input.quantity,
        maxContributionCents: input.maxContributionCents,
        pickupWindow: input.pickupWindow,
        revision: open.revision + 1,
        updatedAt: runtime.now(),
      })
      .where(and(eq(needs.id, open.id), eq(needs.status, "forming")))
      .returning();
  } else {
    [row] = await tx
      .insert(needs)
      .values({
        id: runtime.newId("need"),
        sessionId: input.sessionId,
        shopperId: input.shopperId,
        acceptedOfferIds: [input.offerId],
        quantity: input.quantity,
        maxContributionCents: input.maxContributionCents,
        pickupZone: input.pickupZone,
        pickupWindow: input.pickupWindow,
        status: "reserved",
        reservedGroupId: input.groupId,
        createdAt: runtime.now(),
      })
      .returning();
  }
  if (!row) throw new DomainError("NEED_UNAVAILABLE", "Your request changed; try again.");
  return row;
}

export interface CreateGroupInput {
  offerId: string;
  quantity: number;
  maxContributionCents: number;
  pickupWindow: string;
  visibility: Exclude<GroupVisibility, "private">;
  autoPurchase: boolean;
  autoPay: boolean;
}

/**
 * Organizer-first flow: the shopper takes their share of a package and opens a group that others
 * join until the package is exactly filled.
 */
export async function createOpenGroup(
  providers: Providers,
  ctx: ActionContext,
  input: CreateGroupInput,
): Promise<string> {
  const db = getDb();
  const { session } = ctx;
  const [offer] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.sessionId, session.id), eq(offers.id, input.offerId)));
  if (!offer) throw new DomainError("NOT_FOUND", "Product not found.");
  const terms = toOfferTerms(offer);
  if (!isOfferOpen(terms, runtime.now())) {
    throw new DomainError("OFFER_CHANGED", "This offer is no longer available.");
  }
  if (!offer.pickupWindows.includes(input.pickupWindow)) {
    throw new DomainError("INVALID_INPUT", "Please fix the highlighted fields.", {
      fields: { pickupWindow: "This product is not available in that pickup slot." },
    });
  }
  const { shopper, available } = await availableCents(
    providers,
    session,
    ctx.shopperId,
    input.pickupWindow,
  );
  if (offer.membershipRequired && !shopper.memberships.includes(offer.membershipRequired)) {
    throw new DomainError("INVALID_INPUT", JOIN_ISSUE_TEXT.membership_required, {
      fields: { offer: JOIN_ISSUE_TEXT.membership_required },
    });
  }
  const evaluation = evaluateJoin({
    offer: terms,
    memberQuantities: [],
    quantity: input.quantity,
    maxContributionCents: input.maxContributionCents,
    availableCents: available,
  });
  if (!evaluation.ok) {
    const field = evaluation.issue === "over_budget" ? "maxContribution" : "quantity";
    throw new DomainError("INVALID_INPUT", JOIN_ISSUE_TEXT[evaluation.issue], {
      fields: { [field]: JOIN_ISSUE_TEXT[evaluation.issue] },
    });
  }
  const quote = evaluation.quote;
  const groupId = runtime.newId("grp");

  await db.transaction(async (tx) => {
    const [group] = await tx
      .insert(groups)
      .values({
        id: groupId,
        sessionId: session.id,
        offerId: offer.id,
        offerSnapshot: toOfferSnapshot(offer),
        status: "open",
        initiatingNeedId: "",
        organizerShopperId: ctx.shopperId,
        collectionAccountRef: null,
        analyticsSnapshot: {
          source: databaseLabel(),
          queryId: null,
          candidateCount: 0,
          queriedAt: runtime.now().toISOString(),
          exclusions: [],
        },
        totalCents: offer.totalCents,
        packageQuantity: offer.packageQuantity,
        pickupZone: offer.pickupZone,
        pickupWindow: input.pickupWindow,
        origin: "organizer",
        visibility: input.visibility,
        inviteCode: newInviteCode(),
        autoPurchase: input.autoPurchase,
        autoReplace: true,
        createdAt: runtime.now(),
        updatedAt: runtime.now(),
      })
      .returning();
    if (!group) throw new Error("Group insert failed");
    const need = await reserveNeed(tx, {
      sessionId: session.id,
      shopperId: ctx.shopperId,
      offerId: offer.id,
      pickupZone: offer.pickupZone,
      pickupWindow: input.pickupWindow,
      quantity: input.quantity,
      maxContributionCents: input.maxContributionCents,
      groupId,
    });
    await tx.update(groups).set({ initiatingNeedId: need.id }).where(eq(groups.id, groupId));
    const [allocation] = await tx
      .insert(allocations)
      .values({
        id: runtime.newId("alc"),
        sessionId: session.id,
        groupId,
        needId: need.id,
        shopperId: ctx.shopperId,
        position: 0,
        quantity: quote.quantity,
        contributionCents: quote.contributionCents,
        baselineCents: quote.baselineCents,
        baselineEstimated: quote.baselineEstimated,
        savingsCents: quote.savingsCents,
        state: "active",
        consent: consentFor(offer, quote, input.pickupWindow),
        autoPay: input.autoPay,
        createdAt: runtime.now(),
        updatedAt: runtime.now(),
      })
      .returning();
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId,
      actor: ctx.actor,
      type: "group_created",
      payload: {
        quantity: quote.quantity,
        contributionCents: quote.contributionCents,
        visibility: input.visibility,
        autoPurchase: input.autoPurchase,
      },
    });
    await notify(tx, {
      sessionId: session.id,
      shopperIds: [ctx.shopperId],
      groupId,
      kind: "group_created",
      message: `Your ${offer.productName} group is open with your ${quote.quantity} ${offer.unit}. ${offer.packageQuantity - quote.quantity} ${offer.unit} left to fill${input.visibility === "invite" ? " — share your invite link" : ""}.`,
    });
  });
  return groupId;
}

function consentFor(
  offer: { id: string; version: number; pickupZone: string },
  quote: { quantity: number; contributionCents: number },
  pickupWindow: string,
) {
  return {
    offerId: offer.id,
    offerVersion: offer.version,
    quantity: quote.quantity,
    contributionCents: quote.contributionCents,
    pickupZone: offer.pickupZone,
    pickupWindow,
    consentedAt: runtime.now().toISOString(),
  };
}

export interface JoinInput {
  quantity: number;
  maxContributionCents: number;
  autoPay: boolean;
  inviteCode?: string | null;
}

/**
 * Join an organizer-created group: take any fitting quantity while it is open, or exactly the
 * vacated share when it needs a replacement. Joining records consent to the quoted share.
 */
export async function joinGroup(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
  input: JoinInput,
) {
  const db = getDb();
  const { session } = ctx;
  const preview = await loadGroupBundle(db, session.id, groupId);
  assertVersion(preview.group, expectedVersion);
  assertJoinAllowed(preview.group, ctx, input.inviteCode ?? null);
  const { available } = await availableCents(
    providers,
    session,
    ctx.shopperId,
    preview.group.pickupWindow,
  );

  const outcome = await db.transaction(async (tx) => {
    const group = await lockGroup(tx, session.id, groupId);
    assertVersion(group, expectedVersion);
    let bundle = await loadBundleFor(tx, group);
    if (currentMembers(bundle.allocations).some((row) => row.shopperId === ctx.shopperId)) {
      throw new DomainError("NEED_UNAVAILABLE", "You're already in this group.");
    }
    if (!isOfferOpen(toOfferTerms(bundle.offer), runtime.now())) {
      throw new DomainError("OFFER_CHANGED", "This offer is no longer available.");
    }
    const slot = joinSlotFor(bundle);
    if (!slot)
      throw new DomainError("INCOMPATIBLE_STATE", "This group isn't taking new members right now.");

    let quote: JoinQuote;
    if (slot.mode === "open") {
      const evaluation = evaluateJoin({
        offer: toOfferTerms(bundle.offer),
        memberQuantities: currentMembers(bundle.allocations).map((row) => row.quantity),
        quantity: input.quantity,
        maxContributionCents: input.maxContributionCents,
        availableCents: available,
      });
      if (!evaluation.ok) {
        throw new DomainError("INVALID_INPUT", JOIN_ISSUE_TEXT[evaluation.issue], {
          fields: {
            [evaluation.issue === "over_budget" ? "maxContribution" : "quantity"]:
              JOIN_ISSUE_TEXT[evaluation.issue],
          },
        });
      }
      quote = evaluation.quote;
    } else {
      // A replacement takes the vacated share exactly; nobody else's price changes.
      const evaluation = evaluateSlotJoin({
        offer: toOfferTerms(bundle.offer),
        slot,
        quantity: input.quantity,
        maxContributionCents: input.maxContributionCents,
        availableCents: available,
      });
      if (!evaluation.ok) {
        const message =
          evaluation.issue === "slot_quantity"
            ? `This open share is exactly ${slot.quantity} ${bundle.offer.unit}.`
            : JOIN_ISSUE_TEXT[evaluation.issue];
        throw new DomainError("INVALID_INPUT", message, {
          fields: {
            [evaluation.issue === "over_budget" ? "maxContribution" : "quantity"]: message,
          },
        });
      }
      quote = evaluation.quote;
    }

    const need = await reserveNeed(tx, {
      sessionId: session.id,
      shopperId: ctx.shopperId,
      offerId: bundle.offer.id,
      pickupZone: group.pickupZone,
      pickupWindow: group.pickupWindow,
      quantity: quote.quantity,
      maxContributionCents: input.maxContributionCents,
      groupId,
    });
    await tx.insert(allocations).values({
      id: runtime.newId("alc"),
      sessionId: session.id,
      groupId,
      needId: need.id,
      shopperId: ctx.shopperId,
      position: Math.max(...bundle.allocations.map((row) => row.position)) + 1,
      quantity: quote.quantity,
      contributionCents: quote.contributionCents,
      baselineCents: quote.baselineCents,
      baselineEstimated: quote.baselineEstimated,
      savingsCents: quote.savingsCents,
      state: "active",
      consent: consentFor(bundle.offer, quote, group.pickupWindow),
      autoPay: input.autoPay,
      replacesAllocationId: slot.mode === "slot" ? slot.allocationId : null,
      createdAt: runtime.now(),
      updatedAt: runtime.now(),
    });
    const joinerName = (await getShopper(session.id, ctx.shopperId)).displayName;
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId,
      actor: ctx.actor,
      type: slot.mode === "slot" ? "replacement_joined" : "member_joined",
      payload: { quantity: quote.quantity, contributionCents: quote.contributionCents },
    });

    bundle = await loadBundleFor(tx, bundle.group);
    const members = currentMembers(bundle.allocations);
    const remaining =
      bundle.offer.packageQuantity - members.reduce((sum, row) => sum + row.quantity, 0);
    const product = bundle.offer.productName;
    await notify(tx, {
      sessionId: session.id,
      shopperIds: [ctx.shopperId],
      groupId,
      kind: "joined",
      message: `You joined the ${product} group: ${quote.quantity} ${bundle.offer.unit} for ${formatCents(quote.contributionCents)} (save ${formatCents(quote.savingsCents)}).${input.autoPay ? " We'll send your share automatically once it's full." : ""}`,
    });
    await notify(tx, {
      sessionId: session.id,
      shopperIds: members.map((row) => row.shopperId).filter((id) => id !== ctx.shopperId),
      groupId,
      kind: "member_joined",
      message:
        remaining > 0
          ? `${joinerName} joined your ${product} group with ${quote.quantity} ${bundle.offer.unit}. ${remaining} left to fill.`
          : `${joinerName} joined your ${product} group with ${quote.quantity} ${bundle.offer.unit}.`,
    });

    if (slot.mode === "open" && remaining === 0) {
      // Package filled: freeze exact shares. Quotes are rounded-up upper bounds, so a final share can
      // only stay equal or drop by a cent; members keep consent at the lower amount. Anything
      // higher than consented (not expected) would require reconfirmation.
      const shares = finalizeShares(
        bundle.group.totalCents,
        members.map((row) => ({ id: row.needId, quantity: row.quantity })),
      );
      for (const member of members) {
        const share = shares.get(member.needId) ?? member.contributionCents;
        if (share === member.contributionCents) continue;
        const consent =
          member.consent && share < member.consent.contributionCents
            ? { ...member.consent, contributionCents: share }
            : null;
        await tx
          .update(allocations)
          .set({
            contributionCents: share,
            savingsCents: member.baselineCents - share,
            consent,
            updatedAt: runtime.now(),
          })
          .where(eq(allocations.id, member.id));
      }
      bundle = await loadBundleFor(tx, bundle.group);
      const everyoneConsented = currentMembers(bundle.allocations).every((row) => row.consent);
      await setGroupStatus(
        tx,
        bundle,
        everyoneConsented ? "funding" : "awaiting_confirmation",
        ctx.actor,
        "group_full",
      );
    } else {
      await bumpGroupVersion(tx, bundle);
    }
    bundle = await loadBundleFor(tx, bundle.group);
    return bundle.group.status;
  });

  if (outcome === "funding") await ensureCollectionAccount(providers, session, groupId);
  await advanceGroup(providers, session, groupId);
}

function assertJoinAllowed(
  group: { visibility: GroupVisibility; inviteCode: string | null; origin: string },
  ctx: ActionContext,
  inviteCode: string | null,
) {
  if (group.origin !== "organizer") {
    throw new DomainError(
      "INCOMPATIBLE_STATE",
      "Matched groups fill through matching, not joining.",
    );
  }
  if (group.visibility === "invite" && !ctx.demoControl && inviteCode !== group.inviteCode) {
    throw new DomainError("NOT_AUTHORIZED", "This group is invite-only. Use the invite link.");
  }
}

/** Organizer settings: auto-purchase, auto-replacement and listing visibility. */
export async function updateGroupSettings(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
  input: { autoPurchase?: boolean; autoReplace?: boolean; visibility?: "public" | "invite" },
) {
  await getDb().transaction(async (tx) => {
    const group = await lockGroup(tx, ctx.session.id, groupId);
    assertVersion(group, expectedVersion);
    if (group.organizerShopperId !== ctx.shopperId && !ctx.demoControl) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "Only the group organizer can change these settings.",
      );
    }
    if (input.visibility && group.origin !== "organizer") {
      throw new DomainError("INCOMPATIBLE_STATE", "Matched groups are not listed or shared.");
    }
    const bundle = await loadBundleFor(tx, group);
    await tx
      .update(groups)
      .set({
        autoPurchase: input.autoPurchase ?? group.autoPurchase,
        autoReplace: input.autoReplace ?? group.autoReplace,
        visibility: input.visibility ?? group.visibility,
      })
      .where(eq(groups.id, groupId));
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "settings_changed",
      payload: input,
    });
    await bumpGroupVersion(tx, bundle);
  });
  await advanceGroup(providers, ctx.session, groupId);
}

/** A member turns pre-authorized payment on or off for their own share. */
export async function setAutoPay(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
  enabled: boolean,
) {
  await getDb().transaction(async (tx) => {
    const group = await lockGroup(tx, ctx.session.id, groupId);
    assertVersion(group, expectedVersion);
    const bundle = await loadBundleFor(tx, group);
    const allocation = currentMembers(bundle.allocations).find(
      (row) => row.shopperId === ctx.shopperId,
    );
    if (!allocation) throw new DomainError("NOT_AUTHORIZED", "You are not a member of this group.");
    await tx
      .update(allocations)
      .set({ autoPay: enabled, updatedAt: runtime.now() })
      .where(eq(allocations.id, allocation.id));
    await appendGroupEvent(tx, {
      sessionId: ctx.session.id,
      groupId,
      actor: ctx.actor,
      type: "auto_pay_changed",
      payload: { allocationId: allocation.id, enabled },
    });
    await bumpGroupVersion(tx, bundle);
  });
  await advanceGroup(providers, ctx.session, groupId);
}

/** Organizer-created groups that are listed for neighbors and can take someone right now. */
export async function listJoinableGroups(
  session: SessionRow,
  viewerShopperId: string | null,
  filter: { offerIds?: string[]; pickupWindow?: string } = {},
): Promise<GroupView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.sessionId, session.id),
        eq(groups.origin, "organizer"),
        eq(groups.visibility, "public"),
        inArray(groups.status, ["open", "replacement_needed"]),
        filter.offerIds?.length ? inArray(groups.offerId, filter.offerIds) : undefined,
        filter.pickupWindow ? eq(groups.pickupWindow, filter.pickupWindow) : undefined,
      ),
    )
    .orderBy(desc(groups.updatedAt));
  const views: GroupView[] = [];
  for (const group of rows) {
    const bundle = await loadBundleFor(db, group);
    if (!joinSlotFor(bundle)) continue;
    if (currentMembers(bundle.allocations).some((row) => row.shopperId === viewerShopperId))
      continue;
    views.push(buildGroupView(session, bundle, viewerShopperId, null));
  }
  return views;
}

export async function resolveInvite(session: SessionRow, code: string): Promise<string> {
  const [group] = await getDb()
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.sessionId, session.id), eq(groups.inviteCode, code.toUpperCase())));
  if (!group)
    throw new DomainError("NOT_FOUND", "That invite link isn't valid in this demo session.");
  return group.id;
}
