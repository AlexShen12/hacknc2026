import { estimateBaseline } from "@/domain/baseline";
import { MAX_GROUP_SIZE } from "@/domain/matching";
import { allocateByQuantity } from "@/domain/money";
import type { OfferTerms } from "@/domain/types";

/**
 * Quoted share for a quantity before the package is full: the exact proportional amount when it
 * divides evenly, otherwise the rounded-up upper bound. The final largest-remainder share never
 * exceeds this quote.
 */
export function quoteShareCents(totalCents: number, quantity: number, packageQuantity: number) {
  const numerator = BigInt(totalCents) * BigInt(quantity);
  const pkg = BigInt(packageQuantity);
  return Number(numerator / pkg + (numerator % pkg === 0n ? 0n : 1n));
}

export type JoinIssue =
  | "quantity_invalid"
  | "exceeds_remaining"
  | "group_size"
  | "over_budget"
  | "insufficient_available_funds"
  | "no_baseline"
  | "no_savings"
  | "slot_quantity"
  | "membership_required";

export interface JoinQuote {
  quantity: number;
  contributionCents: number;
  baselineCents: number;
  baselineEstimated: boolean;
  savingsCents: number;
}

/**
 * Validate a shopper taking `quantity` units of an open group. Organizer-created groups fill with
 * exact quantities: the package must be fillable within the 2–6 member bound.
 */
export function evaluateJoin(input: {
  offer: OfferTerms;
  memberQuantities: number[];
  quantity: number;
  maxContributionCents: number;
  availableCents: number | null;
}): { ok: true; quote: JoinQuote } | { ok: false; issue: JoinIssue } {
  const { offer, quantity } = input;
  if (!Number.isSafeInteger(quantity) || quantity <= 0)
    return { ok: false, issue: "quantity_invalid" };
  const claimed = input.memberQuantities.reduce((sum, value) => sum + value, 0);
  const remaining = offer.packageQuantity - claimed;
  if (quantity > remaining) return { ok: false, issue: "exceeds_remaining" };
  const members = input.memberQuantities.length + 1;
  if (members > MAX_GROUP_SIZE) return { ok: false, issue: "group_size" };
  // The last allowed member must close the package exactly; a lone organizer must leave room.
  if (members === MAX_GROUP_SIZE && quantity !== remaining)
    return { ok: false, issue: "group_size" };
  if (members === 1 && quantity >= offer.packageQuantity) return { ok: false, issue: "group_size" };
  const estimate = estimateBaseline(offer.baselines, quantity);
  if (estimate === null) return { ok: false, issue: "no_baseline" };
  const { baselineCents } = estimate;
  const contributionCents = quoteShareCents(offer.totalCents, quantity, offer.packageQuantity);
  if (contributionCents > input.maxContributionCents) return { ok: false, issue: "over_budget" };
  if (input.availableCents !== null && contributionCents > input.availableCents) {
    return { ok: false, issue: "insufficient_available_funds" };
  }
  if (baselineCents - contributionCents <= 0) return { ok: false, issue: "no_savings" };
  return {
    ok: true,
    quote: {
      quantity,
      contributionCents,
      baselineCents,
      baselineEstimated: estimate.estimated,
      savingsCents: baselineCents - contributionCents,
    },
  };
}

/**
 * A replacement takes a vacated share exactly: same quantity and amount, so nobody else's price
 * changes. The share must fit the joiner's limit and spendable money and still save them money.
 */
export function evaluateSlotJoin(input: {
  offer: OfferTerms;
  slot: { quantity: number; contributionCents: number };
  quantity: number;
  maxContributionCents: number;
  availableCents: number | null;
}): { ok: true; quote: JoinQuote } | { ok: false; issue: JoinIssue } {
  const { slot } = input;
  if (input.quantity !== slot.quantity) return { ok: false, issue: "slot_quantity" };
  const estimate = estimateBaseline(input.offer.baselines, slot.quantity);
  if (estimate === null) return { ok: false, issue: "no_baseline" };
  if (slot.contributionCents > input.maxContributionCents)
    return { ok: false, issue: "over_budget" };
  if (input.availableCents !== null && slot.contributionCents > input.availableCents) {
    return { ok: false, issue: "insufficient_available_funds" };
  }
  if (estimate.baselineCents - slot.contributionCents <= 0)
    return { ok: false, issue: "no_savings" };
  return {
    ok: true,
    quote: {
      quantity: slot.quantity,
      contributionCents: slot.contributionCents,
      baselineCents: estimate.baselineCents,
      baselineEstimated: estimate.estimated,
      savingsCents: estimate.baselineCents - slot.contributionCents,
    },
  };
}

/** Final exact shares once members' quantities fill the package; sums to the total. */
export function finalizeShares(
  totalCents: number,
  members: { id: string; quantity: number }[],
): Map<string, number> {
  return allocateByQuantity(totalCents, members);
}

export const JOIN_ISSUE_TEXT: Record<JoinIssue, string> = {
  quantity_invalid: "Choose a whole number of units.",
  exceeds_remaining: "That's more than the units still available in this package.",
  group_size: "A group has 2–6 people, and the last person must take exactly the remaining units.",
  over_budget: "This share is above your contribution limit.",
  insufficient_available_funds: "This share would leave too little for your upcoming bills.",
  no_baseline: "This product has no comparison prices, so savings can't be shown.",
  no_savings: "That amount wouldn't save you money compared with buying it alone.",
  membership_required: "This club offer needs an organizer with a (simulated) membership.",
  slot_quantity: "This open share is a fixed amount; take exactly that quantity.",
};
