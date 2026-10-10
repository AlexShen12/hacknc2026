import { describe, expect, it } from "vitest";
import { findProposals, rankReplacements } from "@/domain/matching";
import type { MatchNeed, MatchShopper, OfferTerms } from "@/domain/types";

const now = new Date("2026-10-10T18:00:00Z");

function offer(overrides: Partial<OfferTerms> = {}): OfferTerms {
  return {
    id: "offer-wm",
    retailer: "walmart",
    sku: "DEMO-WM-PT-24",
    productFamily: "paper-towels",
    unit: "rolls",
    packageQuantity: 24,
    itemCents: 6000,
    taxCents: 0,
    feeCents: 0,
    totalCents: 6000,
    baselines: [
      { quantity: 6, baselineCents: 2200 },
      { quantity: 12, baselineCents: 4300 },
    ],
    membershipRequired: null,
    pickupZone: "zone",
    pickupWindows: ["window-a"],
    available: true,
    expiresAt: new Date("2026-10-13T00:00:00Z"),
    version: 1,
    ...overrides,
  };
}

function need(id: string, minutesAgo: number, overrides: Partial<MatchNeed> = {}): MatchNeed {
  return {
    id,
    shopperId: `shopper-${id}`,
    acceptedOfferIds: ["offer-wm"],
    quantity: 6,
    maxContributionCents: 2000,
    pickupZone: "zone",
    pickupWindow: "window-a",
    createdAt: new Date(now.getTime() - minutesAgo * 60_000),
    ...overrides,
  };
}

function shoppers(
  needs: MatchNeed[],
  extra: Record<string, Partial<MatchShopper>> = {},
): Map<string, MatchShopper> {
  return new Map(
    needs.map((item) => [
      item.shopperId,
      {
        id: item.shopperId,
        displayName: item.id,
        memberships: [],
        availableCents: 8000,
        ...extra[item.shopperId],
      },
    ]),
  );
}

describe("featured scenario", () => {
  const alex = need("alex", 0);
  const others = [
    need("jordan", 50),
    need("sam", 40),
    need("riley", 30),
    need("taylor", 20, { maxContributionCents: 1200 }),
    need("casey", 10),
  ];

  it("selects Alex, Jordan, Sam and Riley and excludes Taylor by budget", () => {
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: others,
      offers: [offer()],
      shoppers: shoppers([alex, ...others]),
      now,
    });
    const [best] = result.proposals;
    expect(best?.allocations.map((item) => item.needId)).toEqual([
      "alex",
      "jordan",
      "sam",
      "riley",
    ]);
    expect(best?.allocations.every((item) => item.contributionCents === 1500)).toBe(true);
    expect(best?.allocations.every((item) => item.savingsCents === 700)).toBe(true);
    expect(best?.totalSavingsCents).toBe(2800);
    expect(best?.organizerShopperId).toBe("shopper-alex");
    expect(result.exclusions).toContainEqual(
      expect.objectContaining({ needId: "taylor", reason: "over_budget", minimumShareCents: 1500 }),
    );
    expect(result.exclusions).toContainEqual(
      expect.objectContaining({ needId: "casey", reason: "not_selected" }),
    );
  });

  it("is deterministic regardless of candidate order", () => {
    const shuffled = [...others].reverse();
    const a = findProposals({
      initiatingNeed: alex,
      candidateNeeds: others,
      offers: [offer()],
      shoppers: shoppers([alex, ...others]),
      now,
    });
    const b = findProposals({
      initiatingNeed: alex,
      candidateNeeds: shuffled,
      offers: [offer()],
      shoppers: shoppers([alex, ...others]),
      now,
    });
    expect(b.proposals).toEqual(a.proposals);
  });
});

describe("feasibility rules", () => {
  it("requires the exact package quantity", () => {
    const alex = need("alex", 0);
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [need("b", 5, { quantity: 5 }), need("c", 4, { quantity: 6 })],
      offers: [offer()],
      shoppers: shoppers([alex]),
      now,
    });
    expect(result.proposals).toEqual([]);
  });

  it("rejects groups larger than six shoppers", () => {
    const small = offer({
      packageQuantity: 7,
      totalCents: 700,
      itemCents: 700,
      baselines: [{ quantity: 1, baselineCents: 200 }],
    });
    const needs = Array.from({ length: 7 }, (_, index) =>
      need(`n${index}`, 10 - index, { quantity: 1 }),
    );
    const [initiator, ...rest] = needs;
    if (!initiator) throw new Error("fixture");
    const result = findProposals({
      initiatingNeed: initiator,
      candidateNeeds: rest,
      offers: [small],
      shoppers: shoppers(needs),
      now,
    });
    expect(result.proposals).toEqual([]);
  });

  it("allows a two-person group", () => {
    const alex = need("alex", 0, { quantity: 12, maxContributionCents: 4000 });
    const partner = need("partner", 5, { quantity: 12, maxContributionCents: 4000 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [partner],
      offers: [offer()],
      shoppers: shoppers([alex, partner]),
      now,
    });
    expect(result.proposals[0]?.allocations).toHaveLength(2);
    expect(result.proposals[0]?.allocations[0]?.contributionCents).toBe(3000);
  });

  it("excludes incompatible pickup windows", () => {
    const alex = need("alex", 0, { quantity: 12, maxContributionCents: 4000 });
    const partner = need("partner", 5, {
      quantity: 12,
      maxContributionCents: 4000,
      pickupWindow: "window-b",
    });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [partner],
      offers: [offer({ pickupWindows: ["window-a", "window-b"] })],
      shoppers: shoppers([alex, partner]),
      now,
    });
    expect(result.proposals).toEqual([]);
    expect(result.exclusions[0]?.reason).toBe("pickup_mismatch");
  });

  it("applies the bill buffer through available funds", () => {
    const alex = need("alex", 0, { quantity: 12, maxContributionCents: 4000 });
    const partner = need("partner", 5, { quantity: 12, maxContributionCents: 4000 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [partner],
      offers: [offer()],
      shoppers: shoppers([alex, partner], { "shopper-partner": { availableCents: 2999 } }),
      now,
    });
    expect(result.proposals).toEqual([]);
    expect(result.exclusions[0]?.reason).toBe("insufficient_available_funds");
  });

  it("requires positive savings for every member", () => {
    const alex = need("alex", 0, { quantity: 12, maxContributionCents: 4000 });
    const partner = need("partner", 5, { quantity: 12, maxContributionCents: 4000 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [partner],
      offers: [offer({ baselines: [{ quantity: 12, baselineCents: 3000 }] })],
      shoppers: shoppers([alex, partner]),
      now,
    });
    expect(result.proposals).toEqual([]);
  });

  it("requires a supported baseline", () => {
    const alex = need("alex", 0, { quantity: 8 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [need("b", 5, { quantity: 16 })],
      offers: [offer()],
      shoppers: shoppers([alex]),
      now,
    });
    expect(result.proposals).toEqual([]);
    expect(result.exclusions[0]).toMatchObject({ needId: "alex", reason: "no_baseline" });
  });

  it("chooses the oldest eligible member as organizer for membership offers", () => {
    const club = offer({ id: "offer-co", membershipRequired: "costco" });
    const alex = need("alex", 0, {
      quantity: 12,
      maxContributionCents: 4000,
      acceptedOfferIds: ["offer-co"],
    });
    const member = need("member", 5, {
      quantity: 12,
      maxContributionCents: 4000,
      acceptedOfferIds: ["offer-co"],
    });
    const people = shoppers([alex, member], { "shopper-member": { memberships: ["costco"] } });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [member],
      offers: [club],
      shoppers: people,
      now,
    });
    expect(result.proposals[0]?.organizerShopperId).toBe("shopper-member");

    const noMember = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [member],
      offers: [club],
      shoppers: shoppers([alex, member]),
      now,
    });
    expect(noMember.proposals).toEqual([]);
  });

  it("ignores expired offers", () => {
    const alex = need("alex", 0, { quantity: 12, maxContributionCents: 4000 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [need("b", 5, { quantity: 12, maxContributionCents: 4000 })],
      offers: [offer({ expiresAt: now })],
      shoppers: shoppers([alex]),
      now,
    });
    expect(result.proposals).toEqual([]);
  });

  it("prefers higher total savings across offers, then older requests", () => {
    const alex = need("alex", 0, {
      quantity: 12,
      maxContributionCents: 4000,
      acceptedOfferIds: ["offer-wm", "offer-b"],
    });
    const partner = need("p", 5, {
      quantity: 12,
      maxContributionCents: 4000,
      acceptedOfferIds: ["offer-wm", "offer-b"],
    });
    const cheaper = offer({ id: "offer-b", totalCents: 5000, itemCents: 5000 });
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: [partner],
      offers: [offer(), cheaper],
      shoppers: shoppers([alex, partner]),
      now,
    });
    expect(result.proposals.map((item) => item.offerId)).toEqual(["offer-b", "offer-wm"]);
  });

  it("only considers the 11 oldest compatible candidates", () => {
    const tiny = offer({
      packageQuantity: 2,
      totalCents: 200,
      itemCents: 200,
      baselines: [{ quantity: 1, baselineCents: 150 }],
    });
    const alex = need("alex", 0, { quantity: 1 });
    const others = Array.from({ length: 13 }, (_, index) =>
      need(`n${String(index).padStart(2, "0")}`, 100 - index, { quantity: 1 }),
    );
    const result = findProposals({
      initiatingNeed: alex,
      candidateNeeds: others,
      offers: [tiny],
      shoppers: shoppers([alex, ...others]),
      now,
    });
    const considered = result.exclusions.map((item) => item.needId);
    expect(considered).not.toContain("n11");
    expect(considered).not.toContain("n12");
    expect(result.proposals[0]?.allocations.map((item) => item.needId)).toEqual(["alex", "n00"]);
  });
});

describe("rankReplacements", () => {
  it("fills the exact slot with the oldest compatible request", () => {
    const candidates = [
      need("late", 1),
      need("casey", 10),
      need("taylor", 20, { maxContributionCents: 1200 }),
      need("big", 30, { quantity: 12, maxContributionCents: 4000 }),
    ];
    const ranked = rankReplacements({
      slot: { quantity: 6, contributionCents: 1500 },
      offer: offer(),
      pickupZone: "zone",
      pickupWindow: "window-a",
      candidates,
      shoppers: shoppers(candidates),
      excludedNeedIds: new Set(["jordan"]),
      excludedShopperIds: new Set(["shopper-alex"]),
    });
    expect(ranked.map((item) => item.need.id)).toEqual(["casey", "late"]);
    expect(ranked[0]?.savingsCents).toBe(700);
  });
});
