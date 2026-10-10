import { and, eq, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import type { MatchNeed, OfferTerms } from "@/domain/types";
import type { DbOrTx, Tx } from "@/server/db/client";
import {
  type allocations,
  type bankOperations,
  groups,
  type needs,
  type OfferSnapshot,
  type offers,
  type shoppers,
  syncOutbox,
  workflowEvents,
} from "@/server/db/schema";

export type OfferRow = typeof offers.$inferSelect;
export type NeedRow = typeof needs.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type AllocationRow = typeof allocations.$inferSelect;
export type OperationRow = typeof bankOperations.$inferSelect;
export type ShopperRow = typeof shoppers.$inferSelect;

export function toOfferTerms(offer: OfferRow): OfferTerms {
  return {
    id: offer.id,
    retailer: offer.retailer,
    sku: offer.sku,
    productFamily: offer.productFamily,
    unit: offer.unit,
    packageQuantity: offer.packageQuantity,
    itemCents: offer.itemCents,
    taxCents: offer.taxCents,
    feeCents: offer.feeCents,
    totalCents: offer.totalCents,
    baselines: offer.baselines,
    membershipRequired: offer.membershipRequired ?? null,
    pickupZone: offer.pickupZone,
    pickupWindows: offer.pickupWindows,
    available: offer.available,
    expiresAt: offer.expiresAt,
    version: offer.version,
  };
}

export function toOfferSnapshot(offer: OfferRow): OfferSnapshot {
  return {
    id: offer.id,
    offerKey: offer.offerKey,
    version: offer.version,
    retailer: offer.retailer,
    storeName: offer.storeName,
    productName: offer.productName,
    unit: offer.unit,
    packageQuantity: offer.packageQuantity,
    itemCents: offer.itemCents,
    taxCents: offer.taxCents,
    feeCents: offer.feeCents,
    totalCents: offer.totalCents,
    membershipRequired: offer.membershipRequired ?? null,
    sourceKind: offer.sourceKind,
    retrievedAt: offer.retrievedAt.toISOString(),
    expiresAt: offer.expiresAt.toISOString(),
    image: offer.image,
  };
}

export function toMatchNeed(need: NeedRow): MatchNeed {
  return {
    id: need.id,
    shopperId: need.shopperId,
    acceptedOfferIds: need.acceptedOfferIds,
    quantity: need.quantity,
    maxContributionCents: need.maxContributionCents,
    pickupZone: need.pickupZone,
    pickupWindow: need.pickupWindow,
    createdAt: need.createdAt,
  };
}

/** Append a group event with a monotonic per-group sequence. The group row must be locked. */
export async function appendGroupEvent(
  tx: Tx,
  input: {
    sessionId: string;
    groupId: string;
    actor: string;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const [row] = await tx
    .update(groups)
    .set({ eventSeq: sql`${groups.eventSeq} + 1` })
    .where(eq(groups.id, input.groupId))
    .returning({ seq: groups.eventSeq });
  await tx.insert(workflowEvents).values({
    sessionId: input.sessionId,
    groupId: input.groupId,
    seq: row?.seq ?? null,
    actor: input.actor,
    type: input.type,
    payload: input.payload ?? {},
  });
}

export async function appendSessionEvent(
  tx: DbOrTx,
  input: { sessionId: string; actor: string; type: string; payload?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(workflowEvents).values({
    sessionId: input.sessionId,
    actor: input.actor,
    type: input.type,
    payload: input.payload ?? {},
  });
}

// --- Analytical outbox payloads (keys are lower-cased Snowflake column names) ---

export async function enqueueOffer(tx: DbOrTx, offer: OfferRow): Promise<void> {
  await tx.insert(syncOutbox).values({
    sessionId: offer.sessionId,
    entityType: "offer",
    entityId: offer.id,
    entityVersion: offer.version,
    status: "pending",
    payload: {
      retailer: offer.retailer,
      sku: offer.sku,
      product_family: offer.productFamily,
      package_quantity: offer.packageQuantity,
      total_cents: offer.totalCents,
      baselines: offer.baselines,
      membership_required: offer.membershipRequired,
      pickup_zone: offer.pickupZone,
      pickup_windows: offer.pickupWindows,
      available: offer.available,
      expires_at: offer.expiresAt.toISOString(),
      source_kind: offer.sourceKind,
      retrieved_at: offer.retrievedAt.toISOString(),
    },
  });
}

export async function enqueueNeed(tx: DbOrTx, need: NeedRow): Promise<void> {
  await tx.insert(syncOutbox).values({
    sessionId: need.sessionId,
    entityType: "need",
    entityId: need.id,
    entityVersion: need.revision,
    status: "pending",
    payload: {
      shopper_id: need.shopperId,
      accepted_offer_ids: need.acceptedOfferIds,
      quantity: need.quantity,
      max_contribution_cents: need.maxContributionCents,
      pickup_zone: need.pickupZone,
      pickup_window: need.pickupWindow,
      status: need.status,
      created_at: need.createdAt.toISOString(),
    },
  });
}

export async function enqueueGroup(tx: DbOrTx, group: GroupRow, members: AllocationRow[]) {
  const active = members.filter((member) => member.state !== "departed");
  await tx.insert(syncOutbox).values({
    sessionId: group.sessionId,
    entityType: "group",
    entityId: group.id,
    entityVersion: group.version,
    status: "pending",
    payload: {
      offer_id: group.offerId,
      status: group.status,
      total_cents: group.totalCents,
      total_savings_cents: active.reduce((sum, member) => sum + member.savingsCents, 0),
      member_count: active.length,
      allocations: members.map((member) => ({
        allocation_id: member.id,
        shopper_id: member.shopperId,
        quantity: member.quantity,
        contribution_cents: member.contributionCents,
        savings_cents: member.savingsCents,
        state: member.state,
      })),
      updated_at: group.updatedAt.toISOString(),
    },
  });
}

export async function enqueueOperation(tx: DbOrTx, operation: OperationRow): Promise<void> {
  await tx.insert(syncOutbox).values({
    sessionId: operation.sessionId,
    entityType: "operation",
    entityId: operation.id,
    entityVersion: operation.revision,
    status: "pending",
    payload: {
      group_id: operation.groupId,
      kind: operation.kind,
      status: operation.status,
      amount_cents: operation.amountCents,
      provider_id: operation.providerId,
      updated_at: operation.updatedAt.toISOString(),
    },
  });
}

export async function lockGroup(tx: Tx, sessionId: string, groupId: string): Promise<GroupRow> {
  const [group] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.sessionId, sessionId)))
    .for("update");
  if (!group) throw new DomainError("NOT_FOUND", "Group not found.");
  return group;
}

export function assertVersion(group: GroupRow, expectedVersion: number): void {
  if (group.version !== expectedVersion) {
    throw new DomainError("STALE_PROPOSAL", "This group changed. Review the latest terms.", {
      currentVersion: group.version,
      status: group.status,
    });
  }
}
