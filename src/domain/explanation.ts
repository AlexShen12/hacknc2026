import { formatCents } from "@/domain/money";
import type { ExclusionReason } from "@/domain/types";

/** Everything an explanation may mention. Built from verified domain output only. */
export interface ExplanationEvidence {
  groupId: string;
  proposalVersion: number;
  productName: string;
  retailerLabel: string;
  unit: string;
  packageQuantity: number;
  totalCents: number;
  taxCents: number;
  feeCents: number;
  pickupLabel: string;
  sourceLabel: string;
  members: {
    name: string;
    quantity: number;
    contributionCents: number;
    baselineCents: number;
    /** True when the buying-alone price was estimated from the closest known prices. */
    baselineEstimated?: boolean;
    savingsCents: number;
  }[];
  totalSavingsCents: number;
  excluded: { name: string; reason: ExclusionReason }[];
}

const REASON_TEXT: Record<ExclusionReason, string> = {
  same_shopper: "already has a request in this group",
  offer_not_accepted: "did not choose this product",
  pickup_mismatch: "picks up at a different time or place",
  over_budget: "set a contribution limit below the share price",
  insufficient_available_funds: "wouldn't have enough left for upcoming bills",
  no_baseline: "has no comparable price for this product",
  no_savings: "would not save money with this share",
  not_selected: "asked later, after the package was already filled",
};

export function exclusionText(reason: ExclusionReason): string {
  return REASON_TEXT[reason];
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Deterministic explanation written only from the verified calculation. */
export function templateExplanation(evidence: ExplanationEvidence): string {
  const names = joinNames(evidence.members.map((member) => member.name));
  const sameTerms = evidence.members.every(
    (member) =>
      member.contributionCents === evidence.members[0]?.contributionCents &&
      member.quantity === evidence.members[0]?.quantity,
  );
  const first = evidence.members[0];
  const shareSentence =
    sameTerms && first
      ? `Each person takes ${first.quantity} ${evidence.unit} for ${formatCents(first.contributionCents)} instead of ${first.baselineEstimated ? "about " : ""}${formatCents(first.baselineCents)} buying separately${first.baselineEstimated ? " (estimated)" : ""}, saving ${formatCents(first.savingsCents)}.`
      : `Each share is priced in proportion to its quantity, and everyone pays less than buying the same amount alone.`;
  const estimatedNote = evidence.members.some((member) => member.baselineEstimated)
    ? " Some buying-alone prices are estimated from the closest known package sizes."
    : "";
  const extras =
    evidence.taxCents === 0 && evidence.feeCents === 0
      ? "This demo offer sets tax and fees to zero."
      : `The total includes ${formatCents(evidence.taxCents)} tax and ${formatCents(evidence.feeCents)} fees.`;
  const excluded = evidence.excluded
    .filter((item) => item.reason !== "not_selected")
    .map((item) => `${item.name} ${REASON_TEXT[item.reason]}`);
  const exclusionSentence = excluded.length ? ` Not included: ${excluded.join("; ")}.` : "";
  return (
    `${names} together need exactly the ${evidence.packageQuantity} ${evidence.unit} in one ` +
    `${evidence.retailerLabel} ${evidence.productName} package (${formatCents(evidence.totalCents)} total). ` +
    `${shareSentence} ${extras} Together the group saves ${formatCents(evidence.totalSavingsCents)}, ` +
    `and everyone picks up ${evidence.pickupLabel}.${estimatedNote}${exclusionSentence}`
  );
}

const AMOUNT_PATTERN = /\$\s?(\d{1,6}(?:,\d{3})*)(?:\.(\d{1,2}))?/g;
const BANKING_CLAIMS = /\b(transferred|refunded|deposited|charged|has been paid|have been paid)\b/i;
export const MAX_EXPLANATION_LENGTH = 900;

function evidenceAmounts(evidence: ExplanationEvidence): Set<number> {
  const amounts = new Set<number>([
    evidence.totalCents,
    evidence.taxCents,
    evidence.feeCents,
    evidence.totalSavingsCents,
  ]);
  for (const member of evidence.members) {
    amounts.add(member.contributionCents);
    amounts.add(member.baselineCents);
    amounts.add(member.savingsCents);
  }
  return amounts;
}

export type ExplanationCheck = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Accept model text only when every dollar amount it mentions is one of `allowedCents` and it does
 * not claim money moved. Authoritative numbers are always rendered from code, never this text.
 */
export function validateNarrative(
  raw: unknown,
  allowedCents: ReadonlySet<number>,
  maxLength = MAX_EXPLANATION_LENGTH,
): ExplanationCheck {
  if (typeof raw !== "string") return { ok: false, reason: "not_text" };
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text.length > maxLength) return { ok: false, reason: "too_long" };
  if (BANKING_CLAIMS.test(text)) return { ok: false, reason: "banking_claim" };
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const dollars = Number((match[1] ?? "0").replaceAll(",", ""));
    const cents = dollars * 100 + Number((match[2] ?? "").padEnd(2, "0") || 0);
    if (!allowedCents.has(cents)) return { ok: false, reason: "unsupported_amount" };
  }
  return { ok: true, text };
}

export function validateExplanation(raw: unknown, evidence: ExplanationEvidence): ExplanationCheck {
  return validateNarrative(raw, evidenceAmounts(evidence));
}
