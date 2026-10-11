import { validateNarrative } from "@/domain/explanation";
import { type InsightsEvidence, insightAmounts, templateInsights } from "@/domain/insights";
import type { Retailer } from "@/domain/types";
import { formatPickupWindow, RETAILER_LABELS } from "@/lib/format";
import type { InsightsView } from "@/lib/view-types";
import { log } from "@/server/observability/logger";
import { databaseLabel } from "@/server/config";
import { loadCatalog } from "@/server/fixtures";
import type { Providers } from "@/server/providers";
import type { SessionRow } from "@/server/services/session-service";

const COMPLETED = new Set(["purchased", "fulfilled"]);

function retailerLabel(value: string): string {
  return RETAILER_LABELS[value as Retailer] ?? value;
}

/**
 * Community analytics for this session, run as SQL directly on the operational database (Neon when
 * deployed), plus a plain-language summary written from the same verified numbers.
 */
export async function getInsights(
  providers: Providers,
  session: SessionRow,
): Promise<InsightsView> {
  const rows = await providers.analytics.communityInsights(session.id);
  const windowLabel = (key: string) => {
    const window = session.pickupWindows.find((item) => item.key === key);
    return window ? formatPickupWindow(window.startsAt, window.endsAt) : key;
  };

  const counted = rows.outcomes;
  const groupsTotal = counted.reduce((sum, row) => sum + row.groups, 0);
  const completed = counted.filter((row) => COMPLETED.has(row.status));
  const completedGroups = completed.reduce((sum, row) => sum + row.groups, 0);
  const savingsCents = rows.savings.reduce((sum, row) => sum + row.savingsCents, 0);
  const moneyTotal = (kind: string) =>
    rows.money
      .filter((row) => row.kind === kind && row.status === "confirmed")
      .reduce((sum, row) => sum + row.amountCents, 0);

  const demand = rows.demand.map((row) => ({
    ...row,
    retailerLabel: retailerLabel(row.retailer),
    pickupLabel: windowLabel(row.pickupWindow),
  }));
  const savings = rows.savings.map((row) => ({
    ...row,
    retailerLabel: retailerLabel(row.retailer),
  }));
  const totals = {
    savingsCents,
    completedGroups,
    groupsFormed: groupsTotal,
    fillRatePercent: groupsTotal === 0 ? 0 : Math.round((completedGroups / groupsTotal) * 100),
    shoppersServed: savings.reduce((sum, row) => sum + row.shoppers, 0),
    unitsShared: savings.reduce((sum, row) => sum + row.units, 0),
    openNeeds: demand.reduce((sum, row) => sum + row.openNeeds, 0),
    fillablePackages: demand.reduce((sum, row) => sum + row.fillablePackages, 0),
    collectedCents: moneyTotal("contribution"),
    returnedCents: moneyTotal("return"),
    purchasedCents: moneyTotal("purchase"),
  };

  const top = savings[0];
  const busiest = demand[0];
  const evidence: InsightsEvidence = {
    savingsCents: totals.savingsCents,
    completedGroups: totals.completedGroups,
    shoppersServed: totals.shoppersServed,
    unitsShared: totals.unitsShared,
    openNeeds: totals.openNeeds,
    fillablePackages: totals.fillablePackages,
    collectedCents: totals.collectedCents,
    returnedCents: totals.returnedCents,
    topProduct: top
      ? { name: `${top.retailerLabel} ${top.productName}`, savingsCents: top.savingsCents }
      : null,
    busiestDemand: busiest
      ? {
          name: `${busiest.retailerLabel} ${busiest.productName}`,
          pickupLabel: busiest.pickupLabel,
          requestedUnits: busiest.requestedUnits,
          packageQuantity: busiest.packageQuantity,
        }
      : null,
  };

  return {
    engine: databaseLabel(),
    generatedAt: new Date().toISOString(),
    totals,
    demand,
    savings,
    outcomes: rows.outcomes,
    money: rows.money,
    storeSpending: await storeSpending(providers, session),
    bankLabel: providers.banking.name === "nessie" ? "Capital One Nessie" : "the simulated bank",
    summary: await summarize(providers, session.id, evidence),
  };
}

/**
 * Purchases at each store, read back from the bank's merchant records (Nessie's
 * GET /merchants/{id}/purchases in sponsor mode) rather than from our own records.
 */
async function storeSpending(
  providers: Providers,
  session: SessionRow,
): Promise<InsightsView["storeSpending"]> {
  const stores = loadCatalog().stores;
  const rows = await Promise.all(
    (Object.keys(stores) as Retailer[]).map(async (retailer) => {
      const merchantRef = session.merchantRefs[retailer];
      if (!merchantRef) return null;
      try {
        const purchases = (await providers.banking.listMerchantPurchases(merchantRef)).filter(
          (purchase) => ["completed", "executed"].includes(purchase.status.toLowerCase()),
        );
        return {
          retailerLabel: retailerLabel(retailer),
          storeName: stores[retailer].name,
          purchases: purchases.length,
          amountCents: purchases.reduce((sum, purchase) => sum + purchase.amountCents, 0),
        };
      } catch (error) {
        log("warn", "insights.store_spending_failed", { sessionId: session.id, error: String(error) });
        return null;
      }
    }),
  );
  return rows
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.amountCents - a.amountCents);
}

/** Plain-language highlights, checked so they only mention amounts from the evidence. */
async function summarize(
  providers: Providers,
  sessionId: string,
  evidence: InsightsEvidence,
): Promise<InsightsView["summary"]> {
  const fallback = templateInsights(evidence);
  try {
    const response = await providers.analytics.summarizeInsights(evidence);
    const check = validateNarrative(response.text, insightAmounts(evidence), 600);
    return { text: check.ok ? check.text : fallback };
  } catch (error) {
    log("warn", "insights.summary_failed", { sessionId, error: String(error) });
    return { text: fallback };
  }
}
