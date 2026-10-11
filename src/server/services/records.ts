import { and, eq, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { hasLeft, type MatchNeed, type OfferTerms } from "@/domain/types";
import type { DbOrTx, Tx } from "@/server/db/client";
import {
  type allocations,
  type bankOperations,
  groups,
  type needs,
  type OfferSnapshot,
  type offers,
  type shoppers,
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
