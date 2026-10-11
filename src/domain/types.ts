export const PROVIDER_MODES = ["sponsor", "rehearsal"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const GROUP_STATUSES = [
  "open",
  "awaiting_confirmation",
  "funding",
  "returning_contribution",
  "replacement_needed",
  "ready_to_purchase",
  "purchasing",
  "purchased",
  "fulfilled",
  "cancelling",
  "cancelled",
] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/** `matched`: proposed by the optimizer. `organizer`: created by a shopper and filled by joiners. */
export type GroupOrigin = "matched" | "organizer";
/** `private`: matched proposal. `public`: listed for nearby shoppers. `invite`: link only. */
export type GroupVisibility = "private" | "public" | "invite";

export const OPERATION_STATUSES = [
  "prepared",
  "dispatching",
  "pending",
  "confirmed",
  "failed",
  "unknown",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];
/** Group money movements, plus wallet top-ups and bill payments that belong to no group. */
export type OperationKind = "contribution" | "return" | "purchase" | "deposit" | "bill_payment";

/** `forming` is open shopping demand before a proposal reserves it. */
export const NEED_STATUSES = ["forming", "reserved", "withdrawn", "fulfilled"] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];

/**
 * `departed`: left after terms were frozen; the share is a vacancy to refill exactly.
 * `released`: left an organizer group before it filled; the units simply became available again.
 */
export const ALLOCATION_STATES = [
  "active",
  "departing",
  "departed",
  "released",
  "picked_up",
] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

/** True once a shopper is no longer part of the group (vacated or released). */
export function hasLeft(state: AllocationState): boolean {
  return state === "departed" || state === "released";
}

export type Retailer = "walmart" | "costco" | "sams_club";
export type Membership = "costco" | "sams_club";

export interface ComparisonBaseline {
  quantity: number;
  baselineCents: number;
}

/** Offer terms the optimizer needs. Monetary fields are integer USD cents. */
export interface OfferTerms {
  id: string;
  retailer: Retailer;
  sku: string;
  productFamily: string;
  unit: string;
  packageQuantity: number;
  itemCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  baselines: ComparisonBaseline[];
  membershipRequired: Membership | null;
  pickupZone: string;
  pickupWindows: string[];
  available: boolean;
  expiresAt: Date;
  version: number;
}

export interface MatchNeed {
  id: string;
  shopperId: string;
  acceptedOfferIds: string[];
  quantity: number;
  maxContributionCents: number;
  pickupZone: string;
  pickupWindow: string;
  createdAt: Date;
}

export interface MatchShopper {
  id: string;
  displayName: string;
  memberships: Membership[];
  /** Account balance minus the shopper's selected buffer; null when not checked. */
  availableCents: number | null;
}

export interface ProposedAllocation {
  needId: string;
  shopperId: string;
  quantity: number;
  contributionCents: number;
  baselineCents: number;
  /** True when the comparison price was estimated from the closest known prices. */
  baselineEstimated: boolean;
  savingsCents: number;
}

export interface ProposalPlan {
  offerId: string;
  offerVersion: number;
  organizerShopperId: string;
  initiatingNeedId: string;
  pickupZone: string;
  pickupWindow: string;
  totalCents: number;
  totalSavingsCents: number;
  allocations: ProposedAllocation[];
}

export type ExclusionReason =
  | "same_shopper"
  | "offer_not_accepted"
  | "pickup_mismatch"
  | "over_budget"
  | "insufficient_available_funds"
  | "no_baseline"
  | "no_savings"
  | "not_selected";

export interface CandidateExclusion {
  needId: string;
  shopperId: string;
  offerId: string;
  reason: ExclusionReason;
  /** Smallest share this need could be allocated under this offer. */
  minimumShareCents: number;
}
