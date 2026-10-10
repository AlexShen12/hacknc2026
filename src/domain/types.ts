export const PROVIDER_MODES = ["sponsor", "rehearsal"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const GROUP_STATUSES = [
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

export const OPERATION_STATUSES = [
  "prepared",
  "dispatching",
  "pending",
  "confirmed",
  "failed",
  "unknown",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];
export type OperationKind = "contribution" | "return" | "purchase";

/** `forming` is open shopping demand before a proposal reserves it. */
export const NEED_STATUSES = ["forming", "reserved", "withdrawn", "fulfilled"] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];

export const ALLOCATION_STATES = ["active", "departing", "departed", "picked_up"] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

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
