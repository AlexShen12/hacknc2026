import { and, asc, desc, eq, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { RETAILER_LABELS } from "@/lib/format";
import type { NeedView, OfferView } from "@/lib/view-types";
import { getDb } from "@/server/db/client";
import { needs, offers } from "@/server/db/schema";
import { runtime } from "@/server/runtime";
import {
  appendSessionEvent,
  enqueueNeed,
  type NeedRow,
  type OfferRow,
} from "@/server/services/records";
import type { SessionRow } from "@/server/services/session-service";

export function toOfferView(offer: OfferRow): OfferView {
  return {
    id: offer.id,
    offerKey: offer.offerKey,
    version: offer.version,
    retailer: offer.retailer,
    retailerLabel: RETAILER_LABELS[offer.retailer],
    storeName: offer.storeName,
    sku: offer.sku,
    productFamily: offer.productFamily,
    productName: offer.productName,
    unit: offer.unit,
    packageQuantity: offer.packageQuantity,
    itemCents: offer.itemCents,
    taxCents: offer.taxCents,
    feeCents: offer.feeCents,
    totalCents: offer.totalCents,
    baselines: offer.baselines,
    membershipRequired: offer.membershipRequired ?? null,
    pickupWindows: offer.pickupWindows,
    available: offer.available,
    expiresAt: offer.expiresAt.toISOString(),
    image: offer.image,
    sourceKind: offer.sourceKind,
    sourceLabel:
      offer.sourceKind === "fixture"
        ? `Fictional demo offer (fixture ${offer.fixtureVersion})`
        : `Observed public page${offer.sourceUrl ? ` ${offer.sourceUrl}` : ""}`,
    retrievedAt: offer.retrievedAt.toISOString(),
  };
}

export function toNeedView(need: NeedRow): NeedView {
  return {
    id: need.id,
    shopperId: need.shopperId,
    offerIds: need.acceptedOfferIds,
    quantity: need.quantity,
    maxContributionCents: need.maxContributionCents,
    pickupWindow: need.pickupWindow,
    status: need.status,
    groupId: need.reservedGroupId,
    createdAt: need.createdAt.toISOString(),
  };
}

export async function listOffers(sessionId: string): Promise<OfferView[]> {
  const rows = await getDb()
    .select()
    .from(offers)
    .where(eq(offers.sessionId, sessionId))
    .orderBy(asc(offers.productFamily), asc(offers.retailer));
  return rows.map(toOfferView);
}

export async function listNeedsForShopper(
  sessionId: string,
  shopperId: string,
): Promise<NeedView[]> {
  const rows = await getDb()
    .select()
    .from(needs)
    .where(and(eq(needs.sessionId, sessionId), eq(needs.shopperId, shopperId)))
    .orderBy(desc(needs.createdAt));
  return rows.map(toNeedView);
}

export async function getNeed(sessionId: string, needId: string): Promise<NeedRow> {
  const [need] = await getDb()
    .select()
    .from(needs)
    .where(and(eq(needs.sessionId, sessionId), eq(needs.id, needId)));
  if (!need) throw new DomainError("NOT_FOUND", "Request not found.");
  return need;
}

export interface NeedInput {
  offerId: string;
  quantity: number;
  maxContributionCents: number;
  pickupWindow: string;
}

/**
 * Record the selected shopper's need. An existing open request for the same product is updated
 * in place (new revision) rather than duplicated.
 */
export async function createNeed(
  session: SessionRow,
  shopperId: string,
  input: NeedInput,
): Promise<NeedView> {
  const db = getDb();
  const [offer] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.sessionId, session.id), eq(offers.id, input.offerId)));
  if (!offer) throw new DomainError("NOT_FOUND", "Product not found.");

  const fields: Record<string, string> = {};
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    fields.quantity = "Enter a whole number of units.";
  } else if (input.quantity >= offer.packageQuantity) {
    fields.quantity = `Choose fewer than ${offer.packageQuantity} ${offer.unit} so the package can be shared.`;
  }
  if (!Number.isSafeInteger(input.maxContributionCents) || input.maxContributionCents <= 0) {
    fields.maxContribution = "Enter how much you can contribute.";
  }
  if (!offer.pickupWindows.includes(input.pickupWindow)) {
    fields.pickupWindow = "This product is not available in that pickup slot.";
  }
  if (Object.keys(fields).length > 0) {
    throw new DomainError("INVALID_INPUT", "Please fix the highlighted fields.", { fields });
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(needs)
      .where(
        and(
          eq(needs.sessionId, session.id),
          eq(needs.shopperId, shopperId),
          sql`${needs.acceptedOfferIds} @> ${JSON.stringify([offer.id])}::jsonb`,
          sql`${needs.status} in ('forming', 'reserved')`,
        ),
      )
      .for("update");
    const reserved = existing.find((need) => need.status === "reserved");
    if (reserved) {
      throw new DomainError("NEED_UNAVAILABLE", "You already have a group for this product.", {
        groupId: reserved.reservedGroupId,
      });
    }
    const open = existing[0];
    let row: NeedRow | undefined;
    if (open) {
      const unchanged =
        open.quantity === input.quantity &&
        open.maxContributionCents === input.maxContributionCents &&
        open.pickupWindow === input.pickupWindow;
      if (unchanged) return toNeedView(open);
      [row] = await tx
        .update(needs)
        .set({
          quantity: input.quantity,
          maxContributionCents: input.maxContributionCents,
          pickupWindow: input.pickupWindow,
          revision: open.revision + 1,
          updatedAt: runtime.now(),
        })
        .where(eq(needs.id, open.id))
        .returning();
    } else {
      [row] = await tx
        .insert(needs)
        .values({
          id: runtime.newId("need"),
          sessionId: session.id,
          shopperId,
          acceptedOfferIds: [offer.id],
          quantity: input.quantity,
          maxContributionCents: input.maxContributionCents,
          pickupZone: offer.pickupZone,
          pickupWindow: input.pickupWindow,
          status: "forming",
          createdAt: runtime.now(),
        })
        .returning();
    }
    if (!row) throw new Error("Need write failed");
    await enqueueNeed(tx, row);
    await appendSessionEvent(tx, {
      sessionId: session.id,
      actor: shopperId,
      type: open ? "need_updated" : "need_created",
      payload: {
        needId: row.id,
        quantity: row.quantity,
        maxContributionCents: row.maxContributionCents,
      },
    });
    return toNeedView(row);
  });
}
