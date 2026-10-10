import type { AllocationState, GroupStatus, OperationStatus } from "@/domain/types";

export interface FundingAllocation {
  id: string;
  state: AllocationState;
  contributionCents: number;
  consented: boolean;
  contributionStatus: OperationStatus | null;
  returnStatus: OperationStatus | null;
}

const UNRESOLVED: ReadonlySet<OperationStatus> = new Set([
  "prepared",
  "dispatching",
  "pending",
  "unknown",
]);

export function isUnresolved(status: OperationStatus | null): boolean {
  return status !== null && UNRESOLVED.has(status);
}

/** Money currently held for this allocation: a confirmed contribution not yet confirmed returned. */
export function retainedCents(allocation: FundingAllocation): number {
  if (allocation.contributionStatus !== "confirmed") return 0;
  if (allocation.returnStatus === "confirmed") return 0;
  return allocation.contributionCents;
}

export function totalRetainedCents(allocations: FundingAllocation[]): number {
  return allocations.reduce((sum, allocation) => sum + retainedCents(allocation), 0);
}

export type ReadinessBlocker =
  | "awaiting_consent"
  | "contribution_missing"
  | "contribution_unresolved"
  | "return_unresolved"
  | "departure_in_progress"
  | "total_mismatch"
  | "collection_balance_mismatch";

/**
 * A group may purchase only when every active member's contribution and every departure return is
 * confirmed, retained funds equal the frozen total, and the collection account reconciles.
 */
export function readinessBlockers(input: {
  allocations: FundingAllocation[];
  totalCents: number;
  collectionBalanceCents: number | null;
}): ReadinessBlocker[] {
  const blockers = new Set<ReadinessBlocker>();
  for (const allocation of input.allocations) {
    if (allocation.state === "departing") blockers.add("departure_in_progress");
    if (allocation.state === "departed" && allocation.contributionStatus === "confirmed") {
      if (allocation.returnStatus !== "confirmed") blockers.add("return_unresolved");
    }
    if (allocation.state !== "active") continue;
    if (!allocation.consented) blockers.add("awaiting_consent");
    if (allocation.contributionStatus === null || allocation.contributionStatus === "failed") {
      blockers.add("contribution_missing");
    } else if (allocation.contributionStatus !== "confirmed") {
      blockers.add("contribution_unresolved");
    }
  }
  const retained = totalRetainedCents(input.allocations);
  if (retained !== input.totalCents) blockers.add("total_mismatch");
  if (input.collectionBalanceCents !== null && input.collectionBalanceCents !== retained) {
    blockers.add("collection_balance_mismatch");
  }
  return [...blockers];
}

export const WITHDRAWABLE_STATUSES: ReadonlySet<GroupStatus> = new Set([
  "awaiting_confirmation",
  "funding",
  "returning_contribution",
  "replacement_needed",
  "ready_to_purchase",
]);

export const CANCELLABLE_STATUSES: ReadonlySet<GroupStatus> = new Set([
  "awaiting_confirmation",
  "funding",
  "returning_contribution",
  "replacement_needed",
  "ready_to_purchase",
]);

export const TERMINAL_STATUSES: ReadonlySet<GroupStatus> = new Set(["fulfilled", "cancelled"]);
