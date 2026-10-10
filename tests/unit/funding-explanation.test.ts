import { describe, expect, it } from "vitest";
import {
  type ExplanationEvidence,
  templateExplanation,
  validateExplanation,
} from "@/domain/explanation";
import { type FundingAllocation, readinessBlockers, totalRetainedCents } from "@/domain/funding";

function allocation(overrides: Partial<FundingAllocation>): FundingAllocation {
  return {
    id: "a",
    state: "active",
    contributionCents: 1500,
    consented: true,
    contributionStatus: "confirmed",
    returnStatus: null,
    ...overrides,
  };
}

describe("readinessBlockers", () => {
  it("is ready when every contribution is confirmed and the account reconciles", () => {
    const allocations = ["a", "b", "c", "d"].map((id) => allocation({ id }));
    expect(
      readinessBlockers({ allocations, totalCents: 6000, collectionBalanceCents: 6000 }),
    ).toEqual([]);
  });

  it("counts a departed member's money only until its return is confirmed", () => {
    const departed = allocation({ id: "j", state: "departed", returnStatus: "unknown" });
    const active = ["a", "b", "c", "d"].map((id) => allocation({ id }));
    expect(totalRetainedCents([departed, ...active])).toBe(7500);
    expect(
      readinessBlockers({
        allocations: [departed, ...active],
        totalCents: 6000,
        collectionBalanceCents: 7500,
      }),
    ).toEqual(expect.arrayContaining(["return_unresolved", "total_mismatch"]));

    const returned = { ...departed, returnStatus: "confirmed" as const };
    expect(
      readinessBlockers({
        allocations: [returned, ...active],
        totalCents: 6000,
        collectionBalanceCents: 6000,
      }),
    ).toEqual([]);
  });

  it("blocks on pending contributions and balance mismatches", () => {
    const allocations = [
      allocation({ id: "a" }),
      allocation({ id: "b", contributionStatus: "pending" }),
    ];
    expect(
      readinessBlockers({ allocations, totalCents: 3000, collectionBalanceCents: 1400 }),
    ).toEqual(
      expect.arrayContaining([
        "contribution_unresolved",
        "total_mismatch",
        "collection_balance_mismatch",
      ]),
    );
  });
});

const evidence: ExplanationEvidence = {
  groupId: "g",
  proposalVersion: 1,
  productName: "Everyday Paper Towels",
  retailerLabel: "Walmart",
  unit: "rolls",
  packageQuantity: 24,
  totalCents: 6000,
  taxCents: 0,
  feeCents: 0,
  pickupLabel: "Sat 10:00 AM",
  sourceLabel: "Fictional fixture",
  members: ["Alex", "Jordan", "Sam", "Riley"].map((name) => ({
    name,
    quantity: 6,
    contributionCents: 1500,
    baselineCents: 2200,
    savingsCents: 700,
  })),
  totalSavingsCents: 2800,
  excluded: [{ name: "Taylor", reason: "over_budget" }],
};

describe("explanations", () => {
  it("templates only evidence amounts", () => {
    const text = templateExplanation(evidence);
    expect(text).toContain("$15.00");
    expect(text).toContain("$28.00");
    expect(text).toContain("Taylor");
    expect(validateExplanation(text, evidence)).toEqual({ ok: true, text });
  });

  it("rejects invented amounts and banking claims", () => {
    expect(validateExplanation("Each pays $14.00.", evidence)).toEqual({
      ok: false,
      reason: "unsupported_amount",
    });
    expect(validateExplanation("Your $15.00 was transferred.", evidence)).toEqual({
      ok: false,
      reason: "banking_claim",
    });
    expect(validateExplanation(42, evidence)).toMatchObject({ ok: false });
  });
});
