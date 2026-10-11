import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { easternDate } from "@/lib/format";
import { closeDb, getDb } from "@/server/db/client";
import { needs, shoppers } from "@/server/db/schema";
import { contribute } from "@/server/services/funding-service";
import { getInsights } from "@/server/services/insights-service";
import { runMatching } from "@/server/services/matching-service";
import { parseNeedText } from "@/server/services/need-parse-service";
import { createNeed } from "@/server/services/need-service";
import { getWallet } from "@/server/services/wallet-service";
import {
  confirmPickup,
  confirmTerms,
  purchase,
  withdraw,
} from "@/server/services/workflow-service";
import { type Persona, type Scenario, startScenario } from "./helpers";

afterAll(async () => {
  await closeDb();
});

async function alexNeed(s: Scenario, quantity = 6) {
  const alex = await s.ctx("alex");
  return createNeed(alex.session, alex.shopperId, {
    offerId: await s.offerId(),
    quantity,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
  });
}

async function accountOf(s: Scenario, persona: Persona) {
  const [row] = await getDb().select().from(shoppers).where(eq(shoppers.id, s.ids[persona]));
  return row?.fundingAccountRef ?? "";
}

/** Featured journey through purchase and pickups, returning the group ID. */
async function featuredJourney(s: Scenario) {
  const alex = await s.ctx("alex");
  const need = await alexNeed(s);
  const groupId = (await runMatching(s.providers, alex, need.id)).groups[0]?.id ?? "";
  for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
    await confirmTerms(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
  }
  for (const persona of ["alex", "jordan"] as Persona[]) {
    await contribute(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
  }
  await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
  await confirmTerms(s.providers, await s.ctx("casey"), groupId, await s.version(groupId));
  for (const persona of ["casey", "sam", "riley"] as Persona[]) {
    await contribute(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
  }
  await purchase(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
  for (const persona of ["alex", "sam", "riley", "casey"] as Persona[]) {
    await confirmPickup(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
  }
  return groupId;
}

describe("bills decide what a shopper can safely contribute", () => {
  it("excludes a shopper whose bills due before pickup leave too little", async () => {
    const s = await startScenario();
    await s.providers.banking.provisionBill({
      sessionId: s.session.id,
      accountRef: await accountOf(s, "riley"),
      payee: "Car repair",
      amountCents: 6000,
      dueDate: easternDate(new Date()),
    });
    const match = await runMatching(s.providers, await s.ctx("alex"), (await alexNeed(s)).id);
    expect(match.groups[0]?.allocations.map((row) => row.name)).toEqual([
      "Alex",
      "Jordan",
      "Sam",
      "Casey",
    ]);
    expect(match.exclusions).toContainEqual(
      expect.objectContaining({ name: "Riley", reason: "insufficient_available_funds" }),
    );
  });

  it("ignores bills due after the pickup date", async () => {
    const s = await startScenario();
    await s.providers.banking.provisionBill({
      sessionId: s.session.id,
      accountRef: await accountOf(s, "riley"),
      payee: "Next month's rent",
      amountCents: 9000,
      dueDate: "2099-01-01",
    });
    const match = await runMatching(s.providers, await s.ctx("alex"), (await alexNeed(s)).id);
    expect(match.groups[0]?.allocations.map((row) => row.name)).toContain("Riley");
  });
});

describe("wallet", () => {
  it("shows bills, spendable money and each movement verified with the bank", async () => {
    const s = await startScenario();
    await featuredJourney(s);
    const wallet = await getWallet(s.providers, await s.fresh(), s.ids.jordan);
    expect(wallet.bills).toEqual([
      expect.objectContaining({ payee: "Duke Energy", amountCents: 4200, dueBeforePickup: true }),
    ]);
    expect(wallet.effectiveBalanceCents).toBe(10000);
    expect(wallet.spendableCents).toBe(10000 - 4200 - 2000);
    expect(
      wallet.activity.map((row) => [row.kind, row.direction, row.amountCents, row.check]),
    ).toEqual([
      ["return", "in", 1500, "verified"],
      ["contribution", "out", 1500, "verified"],
    ]);
  });
});

describe("community insights (local rehearsal queries)", () => {
  it("summarizes savings, outcomes and money after the featured journey", async () => {
    const s = await startScenario();
    await featuredJourney(s);
    const insights = await getInsights(s.providers, await s.fresh());
    expect(insights.engine).toBe("Postgres");
    expect(insights.totals).toMatchObject({
      savingsCents: 2800,
      completedGroups: 1,
      groupsFormed: 1,
      fillRatePercent: 100,
      shoppersServed: 4,
      unitsShared: 24,
      collectedCents: 7500,
      returnedCents: 1500,
      purchasedCents: 6000,
    });
    expect(insights.savings[0]).toMatchObject({
      productName: "Everyday Paper Towels",
      savingsCents: 2800,
    });
    expect(insights.summary.text).toContain("$28.00");
    expect(insights.demand.map((row) => row.openNeeds).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("plain-English shopping", () => {
  it("returns a draft without creating a need", async () => {
    const s = await startScenario();
    const before = await getDb()
      .select()
      .from(needs)
      .where(and(eq(needs.sessionId, s.session.id), eq(needs.shopperId, s.ids.alex)));
    const draft = await parseNeedText(
      s.providers,
      await s.fresh(),
      "about 5 rolls of paper towels, under $20",
    );
    expect(draft).toMatchObject({
      offerId: await s.offerId(),
      quantity: 5,
      maxContribution: "20.00",
      source: "parser",
    });
    const after = await getDb()
      .select()
      .from(needs)
      .where(and(eq(needs.sessionId, s.session.id), eq(needs.shopperId, s.ids.alex)));
    expect(after).toHaveLength(before.length);
  });

  it("matches a 5-roll request using an estimated comparison price", async () => {
    const s = await startScenario();
    const need = await alexNeed(s, 5);
    const match = await runMatching(s.providers, await s.ctx("alex"), need.id);
    // 5 rolls cannot fill 24 with the seeded 6-roll requests, so no group yet; the request is valid.
    expect(match.exclusions.some((row) => row.name === "You" && row.reason === "no_baseline")).toBe(
      false,
    );
  });
});
