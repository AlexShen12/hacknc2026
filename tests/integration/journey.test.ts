import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { closeDb, getDb } from "@/server/db/client";
import { shoppers } from "@/server/db/schema";
import { runDemoAction } from "@/server/services/demo-service";
import { contribute, reconcileOperation } from "@/server/services/funding-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { getGroupView } from "@/server/services/read-service";
import {
  cancelGroup,
  confirmPickup,
  confirmTerms,
  findReplacement,
  purchase,
  withdraw,
} from "@/server/services/workflow-service";
import { type Persona, type Scenario, startScenario } from "./helpers";

afterAll(async () => {
  await closeDb();
});

/** Alex states the featured need, matches, and all four original members confirm. */
async function fundedGroup(s: Scenario) {
  const alex = await s.ctx("alex");
  const need = await createNeed(alex.session, alex.shopperId, {
    offerId: await s.offerId(),
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
  });
  const match = await runMatching(s.providers, alex, need.id);
  const group = match.groups[0];
  if (!group) throw new Error("no proposal");
  for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
    await confirmTerms(s.providers, await s.ctx(persona), group.id, await s.version(group.id));
  }
  return { match, groupId: group.id };
}

async function pay(s: Scenario, groupId: string, persona: Persona) {
  return contribute(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
}

describe("featured funded-dropout journey", () => {
  it("returns Jordan's money, refills the exact slot with Casey and completes the purchase", async () => {
    const s = await startScenario();
    const { match, groupId } = await fundedGroup(s);

    const first = match.groups[0];
    expect(first?.allocations.map((row) => row.name)).toEqual(["Alex", "Jordan", "Sam", "Riley"]);
    expect(
      first?.allocations.every((row) => row.contributionCents === 1500 && row.savingsCents === 700),
    ).toBe(true);
    expect(match.exclusions).toContainEqual(
      expect.objectContaining({ name: "Taylor", reason: "over_budget", minimumShareCents: 1500 }),
    );
    expect((await s.view(groupId)).status).toBe("funding");

    await pay(s, groupId, "alex");
    await pay(s, groupId, "jordan");
    let view = await s.view(groupId);
    expect(view.retainedCents).toBe(3000);
    expect(view.collectionBalanceCents).toBe(3000);

    await withdraw(s.providers, await s.ctx("jordan"), groupId, view.version);
    view = await s.view(groupId);
    expect(view.status).toBe("replacement_needed");
    expect(view.retainedCents).toBe(1500);
    expect(view.collectionBalanceCents).toBe(1500);
    const jordan = view.allocations.find((row) => row.name === "Jordan");
    expect(jordan).toMatchObject({
      state: "departed",
      returnStatus: "confirmed",
      netContributionCents: 0,
    });
    expect(await s.balance("jordan")).toBe(10000);
    expect((await s.needOf("jordan"))?.status).toBe("withdrawn");

    // Auto-replacement (on by default) already offered Casey the exact share.
    const casey = view.allocations.find((row) => row.name === "Casey");
    expect(casey).toMatchObject({
      quantity: 6,
      contributionCents: 1500,
      consented: false,
      isReplacement: true,
    });

    await confirmTerms(s.providers, await s.ctx("casey"), groupId, view.version);
    expect((await s.view(groupId)).status).toBe("funding");
    for (const persona of ["casey", "sam", "riley"] as Persona[]) await pay(s, groupId, persona);

    view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
    expect(view.retainedCents).toBe(6000);
    expect(view.collectionBalanceCents).toBe(6000);
    for (const row of view.allocations.filter((item) => item.state === "active")) {
      expect(row.contributionCents).toBe(1500);
    }

    await purchase(s.providers, await s.ctx("alex"), groupId, view.version);
    view = await s.view(groupId);
    expect(view.status).toBe("purchased");
    expect(view.collectionBalanceCents).toBe(0);
    expect(view.totalSavingsCents).toBe(2800);
    expect(
      view.operations.filter((row) => row.status === "confirmed").map((row) => row.kind),
    ).toEqual([
      "contribution",
      "contribution",
      "return",
      "contribution",
      "contribution",
      "contribution",
      "purchase",
    ]);

    for (const persona of ["alex", "sam", "riley", "casey"] as Persona[]) {
      await confirmPickup(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    view = await s.view(groupId);
    expect(view.status).toBe("fulfilled");
    expect(await s.balance("alex")).toBe(8500);
    expect(await s.balance("casey")).toBe(8500);
  });
});

describe("concurrency and isolation", () => {
  it("scopes groups to their session", async () => {
    const a = await startScenario();
    const b = await startScenario();
    const { groupId } = await fundedGroup(a);
    await expect(
      getGroupView(b.providers, await b.fresh(), groupId, b.ids.alex),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      confirmTerms(b.providers, await b.ctx("alex"), groupId, await a.version(groupId)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects stale versions", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    const stale = (await s.version(groupId)) - 1;
    await expect(withdraw(s.providers, await s.ctx("sam"), groupId, stale)).rejects.toMatchObject({
      code: "STALE_PROPOSAL",
    });
  });

  it("creates one contribution for duplicate concurrent requests", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    const version = await s.version(groupId);
    const ctx = await s.ctx("alex");
    const results = await Promise.all(
      [1, 2, 3].map(() => contribute(s.providers, ctx, groupId, version)),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await s.balance("alex")).toBe(8500);
    const view = await s.view(groupId);
    expect(view.operations.filter((row) => row.kind === "contribution")).toHaveLength(1);
  });

  it("never lets a withdrawal race past a claimed purchase", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[])
      await pay(s, groupId, persona);
    const version = await s.version(groupId);
    expect((await s.view(groupId)).status).toBe("ready_to_purchase");

    const [bought, left] = await Promise.allSettled([
      purchase(s.providers, await s.ctx("alex"), groupId, version),
      withdraw(s.providers, await s.ctx("sam"), groupId, version),
    ]);
    const view = await s.view(groupId);
    const winners = [bought, left].filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    if (bought.status === "fulfilled") {
      expect(view.status).toBe("purchased");
      expect(await s.balance("sam")).toBe(8500);
    } else {
      expect(view.status).toBe("replacement_needed");
      expect(view.operations.some((row) => row.kind === "purchase")).toBe(false);
      expect(await s.balance("sam")).toBe(10000);
    }
  });
});

describe("failure and recovery workflows", () => {
  it("reconciles an unknown contribution before returning it on departure", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    await runDemoAction(s.providers, await s.fresh(), { action: "set_fault", fault: "unknown" });
    const operation = await pay(s, groupId, "jordan");
    expect(operation.status).toBe("unknown");

    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    let view = await s.view(groupId);
    expect(view.status).toBe("returning_contribution");
    expect(view.blockers).toContain("bank_outcome_unknown");

    await reconcileOperation(s.providers, await s.fresh(), operation.id);
    view = await s.view(groupId);
    expect(view.status).toBe("replacement_needed");
    const jordan = view.allocations.find((row) => row.name === "Jordan");
    expect(jordan).toMatchObject({ contributionStatus: "confirmed", returnStatus: "confirmed" });
    expect(await s.balance("jordan")).toBe(10000);
  });

  it("settles a pending contribution only through reconciliation", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    await runDemoAction(s.providers, await s.fresh(), { action: "set_fault", fault: "pending" });
    const operation = await pay(s, groupId, "alex");
    expect(operation.status).toBe("pending");
    expect(await s.balance("alex")).toBe(10000);
    const reconciled = await reconcileOperation(s.providers, await s.fresh(), operation.id);
    expect(reconciled.status).toBe("confirmed");
    expect(await s.balance("alex")).toBe(8500);
  });

  it("blocks purchase while a return has failed, until an explicit retry confirms it", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    await pay(s, groupId, "jordan");
    await runDemoAction(s.providers, await s.fresh(), { action: "set_fault", fault: "reject" });
    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    let view = await s.view(groupId);
    const failedReturn = view.operations.find((row) => row.kind === "return");
    expect(failedReturn?.status).toBe("failed");
    expect(view.status).toBe("returning_contribution");
    expect(view.blockers).toContain("return_failed");
    expect(await s.balance("jordan")).toBe(8500);

    await runDemoAction(s.providers, await s.fresh(), {
      action: "retry_operation",
      operationId: failedReturn?.id ?? "",
    });
    view = await s.view(groupId);
    expect(view.status).toBe("replacement_needed");
    expect(await s.balance("jordan")).toBe(10000);
  });

  it("reports no replacement and cancels by returning every contribution", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    for (const persona of ["alex", "jordan", "sam"] as Persona[]) await pay(s, groupId, persona);
    // Casey is auto-offered Jordan's slot; then Sam leaves and only Taylor (over budget) remains.
    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    await confirmTerms(s.providers, await s.ctx("casey"), groupId, await s.version(groupId));
    await withdraw(s.providers, await s.ctx("sam"), groupId, await s.version(groupId));
    expect((await s.view(groupId)).status).toBe("replacement_needed");

    await expect(
      findReplacement(s.providers, await s.ctx("alex"), groupId, await s.version(groupId)),
    ).rejects.toMatchObject({ code: "NO_REPLACEMENT" });

    await cancelGroup(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
    const view = await s.view(groupId);
    expect(view.status).toBe("cancelled");
    expect(view.collectionBalanceCents).toBe(0);
    for (const persona of ["alex", "jordan", "sam", "riley", "casey"] as Persona[]) {
      expect(await s.balance(persona)).toBe(10000);
    }
    expect((await s.needOf("riley"))?.status).toBe("forming");
  });

  it("cancels and returns funds when the offer changes after funding", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    await pay(s, groupId, "alex");
    await runDemoAction(s.providers, await s.fresh(), { action: "expire_offer", groupId });
    const view = await s.view(groupId);
    expect(view.status).toBe("cancelled");
    expect(view.statusReason).toBe("offer_changed");
    expect(await s.balance("alex")).toBe(10000);
  });

  it("rejects contributions that would dip into the bill buffer", async () => {
    const s = await startScenario();
    const { groupId } = await fundedGroup(s);
    // Balance checks are snapshots, not holds: re-check before dispatch with the current buffer.
    await getDb().update(shoppers).set({ bufferCents: 9000 }).where(eq(shoppers.id, s.ids.alex));
    await expect(pay(s, groupId, "alex")).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    const view = await s.view(groupId);
    expect(view.operations).toHaveLength(0);
    expect(await s.balance("alex")).toBe(10000);
  });

  it("does not let a shopper act on someone else's request", async () => {
    const s = await startScenario();
    const jordanNeed = await s.needOf("jordan");
    await expect(
      runMatching(s.providers, await s.ctx("alex"), jordanNeed?.id ?? ""),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
