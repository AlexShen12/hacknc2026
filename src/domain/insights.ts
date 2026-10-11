import { formatCents } from "@/domain/money";

/** Verified numbers a community-insights summary may mention. All money is integer cents. */
export interface InsightsEvidence {
  savingsCents: number;
  completedGroups: number;
  shoppersServed: number;
  unitsShared: number;
  openNeeds: number;
  fillablePackages: number;
  collectedCents: number;
  returnedCents: number;
  topProduct: { name: string; savingsCents: number } | null;
  busiestDemand: {
    name: string;
    pickupLabel: string;
    requestedUnits: number;
    packageQuantity: number;
  } | null;
}

export function insightAmounts(evidence: InsightsEvidence): Set<number> {
  const amounts = new Set([evidence.savingsCents, evidence.collectedCents, evidence.returnedCents]);
  if (evidence.topProduct) amounts.add(evidence.topProduct.savingsCents);
  return amounts;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Deterministic summary used in rehearsal and whenever model text is rejected. */
export function templateInsights(evidence: InsightsEvidence): string {
  const parts: string[] = [];
  if (evidence.completedGroups > 0) {
    parts.push(
      `Shoppers here have saved ${formatCents(evidence.savingsCents)} across ${plural(evidence.completedGroups, "completed group")}, sharing ${plural(evidence.unitsShared, "unit")} among ${plural(evidence.shoppersServed, "shopper")}.`,
    );
  } else {
    parts.push("No group has completed a purchase yet in this session.");
  }
  if (evidence.topProduct) {
    parts.push(
      `${evidence.topProduct.name} has produced the most savings (${formatCents(evidence.topProduct.savingsCents)}).`,
    );
  }
  if (evidence.busiestDemand) {
    const demand = evidence.busiestDemand;
    parts.push(
      `${demand.name} has the most open demand: ${demand.requestedUnits} units requested for ${demand.pickupLabel} against a ${demand.packageQuantity}-unit package.`,
    );
  }
  if (evidence.returnedCents > 0) {
    parts.push(
      `${formatCents(evidence.returnedCents)} was handed back to shoppers who left groups.`,
    );
  }
  return parts.join(" ");
}
