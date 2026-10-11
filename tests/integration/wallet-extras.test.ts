import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/server/db/client";
import { runDemoAction } from "@/server/services/demo-service";
import { contribute, reconcileOperation } from "@/server/services/funding-service";
import { getInsights } from "@/server/services/insights-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { listNotifications } from "@/server/services/notification-service";
import { getShopper } from "@/server/services/session-service";
import { addFunds, getWallet, payBill } from "@/server/services/wallet-service";
import { confirmPickup, confirmTerms, purchase } from "@/server/services/workflow-service";
import { type Persona, startScenario } from "./helpers";

afterAll(async () => {
  await closeDb();
});

describe("wallet top-ups", () => {
  it("records a deposit once per request and raises what the shopper can spend", async () => {
    const s = await startScenario();
    const before = await getWallet(s.providers, await s.fresh(), s.ids.alex);
    const first = await addFunds(s.providers, await s.ctx("alex"), {
      amountCents: 2500,
      requestKey: "request-key-1",
    });
    const repeat = await addFunds(s.providers, await s.ctx("alex"), {
      amountCents: 2500,
      requestKey: "request-key-1",
    });
    expect(repeat.id).toBe(first.id);
    expect(first.status).toBe("confirmed");

    const after = await getWallet(s.providers, await s.fresh(), s.ids.alex);
    expect(after.effectiveBalanceCents).toBe(before.effectiveBalanceCents + 2500);
    expect(after.spendableCents).toBe(before.spendableCents + 2500);
    expect(after.activity[0]).toMatchObject({
      kind: "deposit",
      direction: "in",
      groupId: null,
      check: "verified",
    });
    const feed = await listNotifications(s.session.id, s.ids.alex);
    expect(feed.items[0]?.message).toBe("$25.00 was added to your account.");
  });

  it("rejects amounts outside $1–$500", async () => {
    const s = await startScenario();
    await expect(
      addFunds(s.providers, await s.ctx("alex"), { amountCents: 50, requestKey: "request-key-2" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reconciles a deposit left pending at the bank", async () => {
    const s = await startScenario();
    await runDemoAction(s.providers, await s.fresh(), { action: "set_fault", fault: "pending" });
    const pending = await addFunds(s.providers, await s.ctx("sam"), {
      amountCents: 1000,
      requestKey: "request-key-3",
    });
    expect(pending.status).toBe("pending");
    const settled = await reconcileOperation(s.providers, await s.fresh(), pending.id);
    expect(settled.status).toBe("confirmed");
    expect((await getWallet(s.providers, await s.fresh(), s.ids.sam)).effectiveBalanceCents).toBe(
      11000,
    );
  });
});

describe("paying bills from the wallet", () => {
  it("pays once, marks the bill paid and leaves spendable money unchanged", async () => {
    const s = await startScenario();
    const before = await getWallet(s.providers, await s.fresh(), s.ids.alex);
    const bill = before.bills[0];
    expect(bill).toMatchObject({ payee: "Spectrum Internet", amountCents: 5500, payment: null });

    const operation = await payBill(s.providers, await s.ctx("alex"), bill?.id ?? "");
    expect(operation.status).toBe("confirmed");
    const again = await payBill(s.providers, await s.ctx("alex"), bill?.id ?? "");
    expect(again.id).toBe(operation.id);

    const after = await getWallet(s.providers, await s.fresh(), s.ids.alex);
    expect(after.bills[0]).toMatchObject({ status: "completed", payment: "confirmed" });
    expect(after.effectiveBalanceCents).toBe(before.effectiveBalanceCents - 5500);
    expect(after.billsDueCents).toBe(0);
    // The bill was already reserved for, so paying it doesn't change what's safe to contribute.
    expect(after.spendableCents).toBe(before.spendableCents);
    expect(after.activity[0]).toMatchObject({
      kind: "bill_payment",
      direction: "out",
      check: "verified",
    });
  });

  it("refuses a bill larger than the account holds", async () => {
    const s = await startScenario();
    const sam = await getShopper(s.session.id, s.ids.sam);
    const { billRef } = await s.providers.banking.provisionBill({
      sessionId: s.session.id,
      accountRef: sam.fundingAccountRef ?? "",
      payee: "Tuition",
      amountCents: 20_000,
      dueDate: "2099-01-01",
    });
    await expect(payBill(s.providers, await s.ctx("sam"), billRef)).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });
  });
});

describe("stores as bank merchants", () => {
  it("reads store spending back from the merchant's purchase records", async () => {
    const s = await startScenario();
    const alex = await s.ctx("alex");
    const need = await createNeed(alex.session, alex.shopperId, {
      offerId: await s.offerId(),
      quantity: 6,
      maxContributionCents: 2000,
      pickupWindow: s.pickupWindow,
    });
    const groupId = (await runMatching(s.providers, alex, need.id)).groups[0]?.id ?? "";
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      await confirmTerms(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      await contribute(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await purchase(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
    await confirmPickup(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));

    const view = await s.view(groupId);
    expect(view.store).toMatchObject({
      name: "Walmart Chapel Hill (fictional demo store)",
      addressLine: "1500 Fordham Blvd, Chapel Hill, NC 27514",
    });
    expect(view.store?.mapUrl).toContain("openstreetmap.org");

    const insights = await getInsights(s.providers, await s.fresh());
    expect(insights.storeSpending.find((row) => row.purchases > 0)).toEqual({
      retailerLabel: "Walmart",
      storeName: "Walmart Chapel Hill (fictional demo store)",
      purchases: 1,
      amountCents: 6000,
    });
  });
});
