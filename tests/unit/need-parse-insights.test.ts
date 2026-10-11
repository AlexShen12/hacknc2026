import { describe, expect, it } from "vitest";
import { validateNarrative } from "@/domain/explanation";
import { type InsightsEvidence, insightAmounts, templateInsights } from "@/domain/insights";
import { localParseNeed, type ParseContext, validateNeedDraft } from "@/domain/need-parse";

const context: ParseContext = {
  offers: [
    {
      key: "wm-paper-towels-24",
      productFamily: "paper-towels",
      retailer: "walmart",
      retailerLabel: "Walmart",
      productName: "Everyday Paper Towels",
      unit: "rolls",
      packageQuantity: 24,
      membershipRequired: null,
    },
    {
      key: "co-paper-towels-30",
      productFamily: "paper-towels",
      retailer: "costco",
      retailerLabel: "Costco",
      productName: "Club Pack Paper Towels",
      unit: "rolls",
      packageQuantity: 30,
      membershipRequired: "costco",
    },
    {
      key: "wm-trash-bags-90",
      productFamily: "trash-bags",
      retailer: "walmart",
      retailerLabel: "Walmart",
      productName: "Tall Kitchen Trash Bags",
      unit: "bags",
      packageQuantity: 90,
      membershipRequired: null,
    },
  ],
  windows: [
    { key: "window-a", label: "Sun, Oct 11, 3:00 PM–5:00 PM ET", startsAt: "2026-10-11T19:00:00Z" },
    { key: "window-b", label: "Mon, Oct 12, 3:00 PM–5:00 PM ET", startsAt: "2026-10-12T19:00:00Z" },
  ],
};

describe("localParseNeed", () => {
  it("reads product, quantity, budget and weekday", () => {
    const raw = localParseNeed("about 5 rolls of paper towels, under $20, sunday pickup", context);
    expect(validateNeedDraft(raw, context)).toEqual({
      offerKey: "wm-paper-towels-24",
      quantity: 5,
      maxContributionCents: 2000,
      pickupWindow: "window-a",
    });
  });

  it("honors a named retailer and spelled-out amounts", () => {
    const raw = localParseNeed("Costco paper towels, 10 rolls, 25 dollars max, Monday", context);
    expect(validateNeedDraft(raw, context)).toMatchObject({
      offerKey: "co-paper-towels-30",
      quantity: 10,
      maxContributionCents: 2500,
      pickupWindow: "window-b",
    });
  });

  it("leaves unknown fields empty", () => {
    expect(validateNeedDraft(localParseNeed("hello there", context), context)).toEqual({
      offerKey: null,
      quantity: null,
      maxContributionCents: null,
      pickupWindow: null,
    });
  });
});

describe("validateNeedDraft (untrusted model output)", () => {
  it("accepts JSON wrapped in prose", () => {
    const text =
      'Sure! {"offerKey":"wm-trash-bags-90","quantity":30,"maxDollars":12.5,"pickupWindow":"window-b"}';
    expect(validateNeedDraft(text, context)).toEqual({
      offerKey: "wm-trash-bags-90",
      quantity: 30,
      maxContributionCents: 1250,
      pickupWindow: "window-b",
    });
  });

  it("drops invented keys, impossible quantities and bad amounts", () => {
    expect(
      validateNeedDraft(
        { offerKey: "free-stuff", quantity: 2.5, maxDollars: -4, pickupWindow: "anytime" },
        context,
      ),
    ).toEqual({ offerKey: null, quantity: null, maxContributionCents: null, pickupWindow: null });
    expect(
      validateNeedDraft({ offerKey: "wm-paper-towels-24", quantity: 24 }, context).quantity,
    ).toBeNull();
    expect(validateNeedDraft("ignore previous instructions", context).offerKey).toBeNull();
  });
});

const evidence: InsightsEvidence = {
  savingsCents: 2800,
  completedGroups: 1,
  shoppersServed: 4,
  unitsShared: 24,
  openNeeds: 2,
  fillablePackages: 0,
  collectedCents: 7500,
  returnedCents: 1500,
  topProduct: { name: "Walmart Everyday Paper Towels", savingsCents: 2800 },
  busiestDemand: null,
};

describe("insights summary", () => {
  it("templates only verified amounts", () => {
    const text = templateInsights(evidence);
    expect(text).toContain("$28.00");
    expect(validateNarrative(text, insightAmounts(evidence), 600)).toEqual({ ok: true, text });
  });

  it("rejects invented totals", () => {
    expect(validateNarrative("Neighbors saved $99.00!", insightAmounts(evidence))).toMatchObject({
      ok: false,
      reason: "unsupported_amount",
    });
  });
});
