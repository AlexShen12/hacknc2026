import { describe, expect, it } from "vitest";
import { evaluateJoin, finalizeShares, quoteShareCents } from "@/domain/open-group";
import type { OfferTerms } from "@/domain/types";

const offer: OfferTerms = {
  id: "o",
  retailer: "walmart",
  sku: "s",
  productFamily: "paper-towels",
  unit: "rolls",
  packageQuantity: 24,
  itemCents: 6000,
  taxCents: 0,
  feeCents: 0,
  totalCents: 6000,
  baselines: [
    { quantity: 4, baselineCents: 1500 },
    { quantity: 6, baselineCents: 2200 },
    { quantity: 12, baselineCents: 4300 },
  ],
  membershipRequired: null,
  pickupZone: "z",
  pickupWindows: ["window-a"],
  available: true,
  expiresAt: new Date("2030-01-01"),
  version: 1,
};

const base = { offer, maxContributionCents: 2000, availableCents: 8000 };

describe("quoteShareCents", () => {
  it("is exact when divisible and an upper bound otherwise", () => {
    expect(quoteShareCents(6000, 6, 24)).toBe(1500);
    expect(quoteShareCents(1000, 1, 3)).toBe(334);
    const final = finalizeShares(1000, [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
      { id: "c", quantity: 1 },
    ]);
    for (const value of final.values()) expect(value).toBeLessThanOrEqual(334);
  });
});

describe("evaluateJoin", () => {
  it("quotes a share within budget with positive savings", () => {
    expect(evaluateJoin({ ...base, memberQuantities: [6], quantity: 6 })).toEqual({
      ok: true,
      quote: {
        quantity: 6,
        contributionCents: 1500,
        baselineCents: 2200,
        baselineEstimated: false,
        savingsCents: 700,
      },
    });
  });

  it("rejects more than the remaining units", () => {
    expect(evaluateJoin({ ...base, memberQuantities: [6, 6, 6], quantity: 12 })).toMatchObject({
      issue: "exceeds_remaining",
    });
  });

  it("requires the sixth member to close the package exactly", () => {
    const five = [4, 4, 4, 4, 4];
    expect(evaluateJoin({ ...base, memberQuantities: five, quantity: 2 })).toMatchObject({
      issue: "group_size",
    });
    expect(evaluateJoin({ ...base, memberQuantities: five, quantity: 4 }).ok).toBe(true);
  });

  it("keeps room for others when an organizer starts a group", () => {
    expect(
      evaluateJoin({ ...base, maxContributionCents: 9000, memberQuantities: [], quantity: 24 }),
    ).toMatchObject({ issue: "group_size" });
  });

  it("applies budget, buffer and baseline rules", () => {
    expect(
      evaluateJoin({ ...base, maxContributionCents: 1200, memberQuantities: [6], quantity: 6 }),
    ).toMatchObject({ issue: "over_budget" });
    expect(
      evaluateJoin({ ...base, availableCents: 1000, memberQuantities: [6], quantity: 6 }),
    ).toMatchObject({ issue: "insufficient_available_funds" });
    expect(evaluateJoin({ ...base, memberQuantities: [6], quantity: 5 })).toMatchObject({
      ok: true,
      quote: { contributionCents: 1250, baselineCents: 1850, baselineEstimated: true },
    });
    expect(
      evaluateJoin({
        ...base,
        offer: { ...offer, baselines: [] },
        memberQuantities: [6],
        quantity: 6,
      }),
    ).toMatchObject({ issue: "no_baseline" });
  });
});
