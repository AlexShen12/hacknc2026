import { estimateBaseline } from "@/domain/baseline";
import { allocateByQuantity, minimumShareCents } from "@/domain/money";
import type {
  CandidateExclusion,
  ExclusionReason,
  MatchNeed,
  MatchShopper,
  OfferTerms,
  ProposalPlan,
  ProposedAllocation,
} from "@/domain/types";

export const MIN_GROUP_SIZE = 2;
export const MAX_GROUP_SIZE = 6;
/** The initiating need plus at most this many other compatible needs per offer. */
export const MAX_OTHER_CANDIDATES = 11;

export interface MatchInput {
  initiatingNeed: MatchNeed;
  candidateNeeds: MatchNeed[];
  offers: OfferTerms[];
  shoppers: ReadonlyMap<string, MatchShopper>;
  now: Date;
}

export interface MatchResult {
  proposals: ProposalPlan[];
  exclusions: CandidateExclusion[];
}

/** Known or estimated comparison price; see `estimateBaseline`. */
export function baselineFor(offer: OfferTerms, quantity: number): number | null {
  return estimateBaseline(offer.baselines, quantity)?.baselineCents ?? null;
}

export function isOfferOpen(offer: OfferTerms, now: Date): boolean {
  return offer.available && offer.expiresAt.getTime() > now.getTime();
}

export function compareRequestAge(a: MatchNeed, b: MatchNeed): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Initiator if eligible, otherwise the oldest eligible participant; null when nobody qualifies. */
export function chooseOrganizer(
  members: MatchNeed[],
  offer: OfferTerms,
  shoppers: ReadonlyMap<string, MatchShopper>,
  preferredShopperId: string | null,
): string | null {
  const eligible = (need: MatchNeed) => {
    if (!offer.membershipRequired) return true;
    return shoppers.get(need.shopperId)?.memberships.includes(offer.membershipRequired) ?? false;
  };
  const preferred = members.find((need) => need.shopperId === preferredShopperId);
  if (preferred && eligible(preferred)) return preferred.shopperId;
  const oldest = [...members].sort(compareRequestAge).find(eligible);
  return oldest?.shopperId ?? null;
}

function offerFitsNeed(offer: OfferTerms, need: MatchNeed): boolean {
  return (
    need.acceptedOfferIds.includes(offer.id) &&
    offer.pickupZone === need.pickupZone &&
    offer.pickupWindows.includes(need.pickupWindow)
  );
}

/** Reasons a need can never join a group for this offer, independent of the other members. */
function individualExclusion(
  offer: OfferTerms,
  need: MatchNeed,
  shopper: MatchShopper | undefined,
): ExclusionReason | null {
  const minimum = minimumShareCents(offer.totalCents, need.quantity, offer.packageQuantity);
  const baseline = baselineFor(offer, need.quantity);
  if (baseline === null) return "no_baseline";
  if (minimum > need.maxContributionCents) return "over_budget";
  if (shopper?.availableCents != null && minimum > shopper.availableCents) {
    return "insufficient_available_funds";
  }
  if (baseline - minimum <= 0) return "no_savings";
  return null;
}

function buildPlan(
  offer: OfferTerms,
  members: MatchNeed[],
  initiator: MatchNeed,
  shoppers: ReadonlyMap<string, MatchShopper>,
): ProposalPlan | null {
  const shares = allocateByQuantity(
    offer.totalCents,
    members.map((need) => ({ id: need.id, quantity: need.quantity })),
  );
  const allocations: ProposedAllocation[] = [];
  for (const need of members) {
    const contributionCents = shares.get(need.id) ?? 0;
    const estimate = estimateBaseline(offer.baselines, need.quantity);
    if (estimate === null) return null;
    const { baselineCents } = estimate;
    const available = shoppers.get(need.shopperId)?.availableCents;
    if (contributionCents > need.maxContributionCents) return null;
    if (available != null && contributionCents > available) return null;
    const savingsCents = baselineCents - contributionCents;
    if (savingsCents <= 0) return null;
    allocations.push({
      needId: need.id,
      shopperId: need.shopperId,
      quantity: need.quantity,
      contributionCents,
      baselineCents,
      baselineEstimated: estimate.estimated,
      savingsCents,
    });
  }
  const organizer = chooseOrganizer(members, offer, shoppers, initiator.shopperId);
  if (!organizer) return null;
  return {
    offerId: offer.id,
    offerVersion: offer.version,
    organizerShopperId: organizer,
    initiatingNeedId: initiator.id,
    pickupZone: initiator.pickupZone,
    pickupWindow: initiator.pickupWindow,
    totalCents: offer.totalCents,
    totalSavingsCents: allocations.reduce((sum, item) => sum + item.savingsCents, 0),
    allocations,
  };
}

function memberAgeKey(plan: ProposalPlan, needsById: ReadonlyMap<string, MatchNeed>): MatchNeed[] {
  return plan.allocations
    .map((allocation) => needsById.get(allocation.needId))
    .filter((need): need is MatchNeed => need !== undefined)
    .sort(compareRequestAge);
}

export function compareProposals(
  a: ProposalPlan,
  b: ProposalPlan,
  needsById: ReadonlyMap<string, MatchNeed>,
): number {
  if (a.totalSavingsCents !== b.totalSavingsCents) {
    return b.totalSavingsCents - a.totalSavingsCents;
  }
  const ka = memberAgeKey(a, needsById);
  const kb = memberAgeKey(b, needsById);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    const left = ka[i];
    const right = kb[i];
    if (left && right) {
      const order = compareRequestAge(left, right);
      if (order !== 0) return order;
    }
  }
  if (ka.length !== kb.length) return ka.length - kb.length;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

/** Exhaustively search one offer for the best group containing the initiator. */
function bestPlanForOffer(
  offer: OfferTerms,
  initiator: MatchNeed,
  others: MatchNeed[],
  shoppers: ReadonlyMap<string, MatchShopper>,
  needsById: ReadonlyMap<string, MatchNeed>,
): ProposalPlan | null {
  let best: ProposalPlan | null = null;
  const chosen: MatchNeed[] = [initiator];

  const visit = (start: number, quantity: number) => {
    if (quantity === offer.packageQuantity) {
      if (chosen.length >= MIN_GROUP_SIZE) {
        const plan = buildPlan(offer, chosen, initiator, shoppers);
        if (plan && (!best || compareProposals(plan, best, needsById) < 0)) best = plan;
      }
      return;
    }
    if (chosen.length >= MAX_GROUP_SIZE) return;
    for (let i = start; i < others.length; i++) {
      const need = others[i];
      if (!need || quantity + need.quantity > offer.packageQuantity) continue;
      if (chosen.some((member) => member.shopperId === need.shopperId)) continue;
      chosen.push(need);
      visit(i + 1, quantity + need.quantity);
      chosen.pop();
    }
  };

  visit(0, initiator.quantity);
  return best;
}

/**
 * Deterministic needs-first matching: one SKU, one package, 2–6 distinct shoppers whose exact
 * quantities fill the package, each within budget and with strictly positive savings.
 */
export function findProposals(input: MatchInput): MatchResult {
  const { initiatingNeed: initiator, shoppers, now } = input;
  const needsById = new Map<string, MatchNeed>([[initiator.id, initiator]]);
  for (const need of input.candidateNeeds) needsById.set(need.id, need);

  const proposals: ProposalPlan[] = [];
  const exclusions: CandidateExclusion[] = [];

  const offers = [...input.offers]
    .filter((offer) => isOfferOpen(offer, now) && offerFitsNeed(offer, initiator))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const offer of offers) {
    const exclude = (need: MatchNeed, reason: ExclusionReason) =>
      exclusions.push({
        needId: need.id,
        shopperId: need.shopperId,
        offerId: offer.id,
        reason,
        minimumShareCents: minimumShareCents(
          offer.totalCents,
          need.quantity,
          offer.packageQuantity,
        ),
      });

    const initiatorIssue = individualExclusion(offer, initiator, shoppers.get(initiator.shopperId));
    if (initiatorIssue) {
      exclude(initiator, initiatorIssue);
      continue;
    }

    const compatible: MatchNeed[] = [];
    for (const need of [...input.candidateNeeds].sort(compareRequestAge)) {
      if (need.id === initiator.id) continue;
      if (need.shopperId === initiator.shopperId) exclude(need, "same_shopper");
      else if (!need.acceptedOfferIds.includes(offer.id)) exclude(need, "offer_not_accepted");
      else if (
        !offerFitsNeed(offer, need) ||
        need.pickupZone !== initiator.pickupZone ||
        need.pickupWindow !== initiator.pickupWindow
      ) {
        exclude(need, "pickup_mismatch");
      } else compatible.push(need);
    }

    const eligible: MatchNeed[] = [];
    for (const need of compatible.slice(0, MAX_OTHER_CANDIDATES)) {
      const issue = individualExclusion(offer, need, shoppers.get(need.shopperId));
      if (issue) exclude(need, issue);
      else eligible.push(need);
    }

    const plan = bestPlanForOffer(offer, initiator, eligible, shoppers, needsById);
    if (plan) proposals.push(plan);
    const members = new Set(plan?.allocations.map((allocation) => allocation.needId) ?? []);
    for (const need of eligible) {
      if (!members.has(need.id)) exclude(need, "not_selected");
    }
  }

  proposals.sort((a, b) => compareProposals(a, b, needsById));
  return { proposals, exclusions };
}

export interface ReplacementSlot {
  quantity: number;
  contributionCents: number;
}

export interface ReplacementCandidate {
  need: MatchNeed;
  baselineCents: number;
  baselineEstimated: boolean;
  savingsCents: number;
}

/**
 * Rank candidates for a vacated fixed slot. The replacement takes the exact quantity and amount;
 * existing members' terms never change.
 */
export function rankReplacements(input: {
  slot: ReplacementSlot;
  offer: OfferTerms;
  pickupZone: string;
  pickupWindow: string;
  candidates: MatchNeed[];
  shoppers: ReadonlyMap<string, MatchShopper>;
  excludedNeedIds: ReadonlySet<string>;
  excludedShopperIds: ReadonlySet<string>;
}): ReplacementCandidate[] {
  const { slot, offer } = input;
  const estimate = estimateBaseline(offer.baselines, slot.quantity);
  if (estimate === null || estimate.baselineCents - slot.contributionCents <= 0) return [];
  const { baselineCents } = estimate;

  return input.candidates
    .filter((need) => {
      if (input.excludedNeedIds.has(need.id) || input.excludedShopperIds.has(need.shopperId)) {
        return false;
      }
      if (need.quantity !== slot.quantity) return false;
      if (!need.acceptedOfferIds.includes(offer.id)) return false;
      if (need.pickupZone !== input.pickupZone || need.pickupWindow !== input.pickupWindow) {
        return false;
      }
      if (need.maxContributionCents < slot.contributionCents) return false;
      const available = input.shoppers.get(need.shopperId)?.availableCents;
      return available == null || available >= slot.contributionCents;
    })
    .sort(compareRequestAge)
    .map((need) => ({
      need,
      baselineCents,
      baselineEstimated: estimate.estimated,
      savingsCents: baselineCents - slot.contributionCents,
    }));
}
