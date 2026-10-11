import { and, asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { type FundingAllocation, readinessBlockers, totalRetainedCents } from "@/domain/funding";
import { hasLeft, type Retailer } from "@/domain/types";
import { formatPickupWindow } from "@/lib/format";
import type {
  AllocationView,
  GroupAction,
  GroupView,
  OperationView,
  StoreView,
} from "@/lib/view-types";
import type { DbOrTx } from "@/server/db/client";
import { allocations, bankOperations, groups, offers, shoppers } from "@/server/db/schema";
import { loadCatalog } from "@/server/fixtures";
import { toOfferView } from "@/server/services/need-service";
import type {
  AllocationRow,
  GroupRow,
  OfferRow,
  OperationRow,
  ShopperRow,
} from "@/server/services/records";
import type { SessionRow } from "@/server/services/session-service";

export interface GroupBundle {
  group: GroupRow;
  offer: OfferRow;
  allocations: AllocationRow[];
  operations: OperationRow[];
  shoppers: Map<string, ShopperRow>;
}

export async function loadGroupBundle(
  db: DbOrTx,
  sessionId: string,
  groupId: string,
): Promise<GroupBundle> {
  const [group] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.sessionId, sessionId)));
  if (!group) throw new DomainError("NOT_FOUND", "Group not found.");
  return loadBundleFor(db, group);
}

export async function loadBundleFor(db: DbOrTx, group: GroupRow): Promise<GroupBundle> {
  const [offer] = await db.select().from(offers).where(eq(offers.id, group.offerId));
  if (!offer) throw new DomainError("NOT_FOUND", "Offer not found.");
  const allocationRows = await db
    .select()
    .from(allocations)
    .where(eq(allocations.groupId, group.id))
    .orderBy(asc(allocations.position));
  const operationRows = await db
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.groupId, group.id))
    .orderBy(asc(bankOperations.createdAt), asc(bankOperations.id));
  const shopperIds = [
    ...new Set([
      ...allocationRows.map((row) => row.shopperId),
      ...group.analyticsSnapshot.exclusions.map((item) => item.shopperId),
    ]),
  ];
  const shopperRows = shopperIds.length
    ? await db.select().from(shoppers).where(inArray(shoppers.id, shopperIds))
    : [];
  return {
    group,
    offer,
    allocations: allocationRows,
    operations: operationRows,
    shoppers: new Map(shopperRows.map((row) => [row.id, row])),
  };
}

export function operationById(bundle: GroupBundle, id: string | null): OperationRow | null {
  if (!id) return null;
  return bundle.operations.find((operation) => operation.id === id) ?? null;
}

export function toFundingAllocations(bundle: GroupBundle): FundingAllocation[] {
  return bundle.allocations.map((allocation) => ({
    id: allocation.id,
    state: allocation.state === "picked_up" ? "active" : allocation.state,
    contributionCents: allocation.contributionCents,
    consented: allocation.consent !== null,
    contributionStatus: operationById(bundle, allocation.contributionOperationId)?.status ?? null,
    returnStatus: operationById(bundle, allocation.returnOperationId)?.status ?? null,
  }));
}

/** Departed allocations whose slot has not been taken by a later allocation. */
export function vacantAllocations(rows: AllocationRow[]): AllocationRow[] {
  const replaced = new Set(rows.map((row) => row.replacesAllocationId).filter(Boolean));
  return rows.filter((row) => row.state === "departed" && !replaced.has(row.id));
}

export function currentMembers(rows: AllocationRow[]): AllocationRow[] {
  return rows.filter((row) => row.state === "active" || row.state === "picked_up");
}

export type JoinSlot =
  | { mode: "open" }
  | { mode: "slot"; allocationId: string; quantity: number; contributionCents: number };

/** What a non-member could join right now: any fitting quantity, or exactly a vacated share. */
export function joinSlotFor(bundle: GroupBundle): JoinSlot | null {
  const { group } = bundle;
  if (group.origin !== "organizer") return null;
  if (group.status === "open") return { mode: "open" };
  if (group.status === "replacement_needed" && !hasPendingReplacement(bundle)) {
    const vacancy = vacantAllocations(bundle.allocations)[0];
    if (vacancy) {
      return {
        mode: "slot",
        allocationId: vacancy.id,
        quantity: vacancy.quantity,
        contributionCents: vacancy.contributionCents,
      };
    }
  }
  return null;
}

export function actionsFor(bundle: GroupBundle, shopperId: string | null): GroupAction[] {
  if (!shopperId) return [];
  const { group } = bundle;
  const allocation = bundle.allocations.find(
    (row) => row.shopperId === shopperId && (row.state === "active" || row.state === "picked_up"),
  );
  if (!allocation) return joinSlotFor(bundle) ? ["join"] : [];
  const isOrganizer =
    group.organizerShopperId === shopperId ||
    (group.organizerShopperId === null && allocation.consent !== null);
  const consented = allocation.consent !== null;
  const contribution = operationById(bundle, allocation.contributionOperationId);
  const actions: GroupAction[] = [];

  switch (group.status) {
    case "open":
      actions.push("withdraw");
      if (isOrganizer) actions.push("cancel");
      break;
    case "awaiting_confirmation":
      if (!consented) actions.push("confirm");
      actions.push("withdraw");
      if (isOrganizer) actions.push("cancel");
      break;
    case "replacement_needed":
      if (!consented) actions.push("confirm");
      else {
        if (vacantAllocations(bundle.allocations).length > 0 || hasPendingReplacement(bundle)) {
          actions.push("replace");
        }
        actions.push("withdraw");
        if (isOrganizer) actions.push("cancel");
      }
      break;
    case "funding":
      if (consented && (!contribution || contribution.status === "failed"))
        actions.push("contribute");
      actions.push("withdraw");
      if (isOrganizer) actions.push("cancel");
      break;
    case "returning_contribution":
      actions.push("withdraw");
      if (isOrganizer) actions.push("cancel");
      break;
    case "ready_to_purchase":
      if (isOrganizer) actions.push("purchase", "cancel");
      actions.push("withdraw");
      break;
    case "purchased":
      if (allocation.state === "active") actions.push("pickup");
      break;
    default:
      break;
  }
  return actions;
}

export function hasPendingReplacement(bundle: GroupBundle): boolean {
  return bundle.allocations.some(
    (row) => row.state === "active" && row.replacesAllocationId !== null && row.consent === null,
  );
}

export function groupBlockers(
  bundle: GroupBundle,
  collectionBalanceCents: number | null,
): string[] {
  const blockers = new Set<string>();
  for (const operation of bundle.operations) {
    if (operation.status === "unknown") blockers.add("bank_outcome_unknown");
    if (operation.status === "dispatching") blockers.add("operation_in_flight");
    if (operation.status === "pending") blockers.add(`${operation.kind}_pending`);
    if (operation.status === "failed" && operation.kind === "return") blockers.add("return_failed");
  }
  if (["funding", "ready_to_purchase", "returning_contribution"].includes(bundle.group.status)) {
    for (const blocker of readinessBlockers({
      allocations: toFundingAllocations(bundle),
      totalCents: bundle.group.totalCents,
      collectionBalanceCents,
    })) {
      blockers.add(blocker);
    }
  }
  if (bundle.group.status === "replacement_needed") {
    blockers.add(hasPendingReplacement(bundle) ? "awaiting_replacement_consent" : "vacant_share");
  }
  return [...blockers];
}

function operationView(bundle: GroupBundle, operation: OperationRow): OperationView {
  const allocation = bundle.allocations.find((row) => row.id === operation.allocationId);
  const shopper = allocation ? bundle.shoppers.get(allocation.shopperId) : undefined;
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    amountCents: operation.amountCents,
    shopperName: shopper?.displayName ?? null,
    providerId: operation.providerId,
    providerStatus: operation.providerStatus,
    attemptCount: operation.attemptCount,
    lastError: operation.lastError
      ? { code: operation.lastError.code, message: operation.lastError.message }
      : null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

export function buildGroupView(
  session: SessionRow,
  bundle: GroupBundle,
  viewerShopperId: string | null,
  collectionBalanceCents: number | null,
): GroupView {
  const { group } = bundle;
  const funding = toFundingAllocations(bundle);
  const window = session.pickupWindows.find((item) => item.key === group.pickupWindow);
  const allocationViews: AllocationView[] = bundle.allocations.map((allocation, index) => {
    const contribution = operationById(bundle, allocation.contributionOperationId);
    const returned = operationById(bundle, allocation.returnOperationId);
    const net =
      (contribution?.status === "confirmed" ? allocation.contributionCents : 0) -
      (returned?.status === "confirmed" ? returned.amountCents : 0);
    return {
      id: allocation.id,
      shopperId: allocation.shopperId,
      name: bundle.shoppers.get(allocation.shopperId)?.displayName ?? "Shopper",
      quantity: allocation.quantity,
      contributionCents: allocation.contributionCents,
      baselineCents: allocation.baselineCents,
      baselineEstimated: allocation.baselineEstimated,
      savingsCents: allocation.savingsCents,
      state: allocation.state,
      consented: allocation.consent !== null,
      isReplacement: allocation.replacesAllocationId !== null,
      isOrganizer: allocation.shopperId === group.organizerShopperId,
      autoPay: allocation.autoPay,
      contributionStatus: funding[index]?.contributionStatus ?? null,
      returnStatus: funding[index]?.returnStatus ?? null,
      netContributionCents: net,
    };
  });
  const viewerAllocation = bundle.allocations.find(
    (row) => row.shopperId === viewerShopperId && !hasLeft(row.state),
  );
  const members = currentMembers(bundle.allocations);
  const memberActions: Record<string, GroupAction[]> = {};
  for (const allocation of bundle.allocations) {
    memberActions[allocation.shopperId] = actionsFor(bundle, allocation.shopperId);
  }
  const explanation = group.explanation;
  const slot = joinSlotFor(bundle);
  return {
    id: group.id,
    store: storeFor(session, bundle.offer.retailer),
    origin: group.origin,
    visibility: group.visibility,
    // Only members see the invite code; otherwise "invite only" could be bypassed from the view.
    inviteCode:
      group.origin === "organizer" && members.some((member) => member.shopperId === viewerShopperId)
        ? group.inviteCode
        : null,
    autoPurchase: group.autoPurchase,
    autoReplace: group.autoReplace,
    remainingUnits:
      group.packageQuantity - members.reduce((sum, member) => sum + member.quantity, 0),
    joinSlot:
      slot?.mode === "slot"
        ? { mode: "slot", quantity: slot.quantity, contributionCents: slot.contributionCents }
        : slot,
    status: group.status,
    statusReason: group.statusReason,
    version: group.version,
    offer: toOfferView(bundle.offer),
    pickupLabel: window ? formatPickupWindow(window.startsAt, window.endsAt) : group.pickupWindow,
    pickupZoneLabel: session.pickupZone.label,
    organizerShopperId: group.organizerShopperId,
    organizerName: group.organizerShopperId
      ? (bundle.shoppers.get(group.organizerShopperId)?.displayName ?? null)
      : null,
    allocations: allocationViews,
    operations: bundle.operations.map((operation) => operationView(bundle, operation)),
    retainedCents: totalRetainedCents(funding),
    totalCents: group.totalCents,
    totalSavingsCents: members.reduce((sum, member) => sum + member.savingsCents, 0),
    collectionBalanceCents,
    vacancies: vacantAllocations(bundle.allocations).length,
    blockers: groupBlockers(bundle, collectionBalanceCents),
    viewer: {
      shopperId: viewerShopperId,
      allocationId: viewerAllocation?.id ?? null,
      actions: actionsFor(bundle, viewerShopperId),
    },
    memberActions,
    explanation: explanation
      ? {
          status: explanation.status,
          source: explanation.source,
          text: explanation.text,
          proposalVersion: explanation.proposalVersion,
          stale: false,
          reason: explanation.reason,
        }
      : null,
    analytics: {
      engine: group.analyticsSnapshot.source,
      candidateCount: group.analyticsSnapshot.candidateCount,
    },
    exclusions: group.analyticsSnapshot.exclusions
      .filter((item) => item.reason !== "not_selected" && item.reason !== "same_shopper")
      .map((item) => ({
        name: bundle.shoppers.get(item.shopperId)?.displayName ?? "A nearby shopper",
        reason: item.reason,
      })),
    updatedAt: group.updatedAt.toISOString(),
  };
}

/** The retailer's (fictional) store, as provisioned as a bank merchant for this session. */
export function storeFor(session: SessionRow, retailer: Retailer): StoreView | null {
  const store = loadCatalog().stores[retailer];
  if (!store) return null;
  const { address, geocode } = store;
  return {
    name: store.name,
    addressLine: `${address.streetNumber} ${address.streetName}, ${address.city}, ${address.state} ${address.zip}`,
    mapUrl: `https://www.openstreetmap.org/?mlat=${geocode.lat}&mlon=${geocode.lng}#map=16/${geocode.lat}/${geocode.lng}`,
    merchantRef: session.merchantRefs[retailer] ?? null,
  };
}
