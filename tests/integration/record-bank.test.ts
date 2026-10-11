import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import { type Providers, setProviderFactory } from "@/server/providers";
import { PostgresAnalyticsProvider } from "@/server/providers/analytics/postgres";
import type {
  BankingProvider,
  BillPaymentInput,
  BillRecord,
  DepositInput,
  RecordKind,
  ObservedOutcome,
  PurchaseInput,
  SubmitOutcome,
  TransferInput,
} from "@/server/providers/banking/types";
import { FixtureRetailProvider } from "@/server/providers/retail/fixtures";
import { effectiveBalanceCents } from "@/server/services/balance-service";
import { contribute } from "@/server/services/funding-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { createSession } from "@/server/services/session-service";
import { confirmTerms, purchase, withdraw } from "@/server/services/workflow-service";
import { startScenario } from "./helpers";

/**
 * Mirrors behavior observed on prod-api.nessieisreal.com (2026-10-10): writes create records with
 * the status sent, balances never change, and records are listed per paying account.
 */
class RecordOnlyBank implements BankingProvider {
  readonly name = "nessie" as const;
  readonly capabilities = {
    correlationLookup: true,
    correlationAbsenceIsProof: false,
    amountUnit: "integer cents",
    verified: true,
    balanceEffects: false,
  };
  readonly accounts = new Map<string, number>();
  readonly records = new Map<
    string,
    {
      from: string;
      to: string;
      amountCents: number;
      status: string;
      description: string;
      kind: RecordKind;
    }
  >();
  private next = 0;

  private id(prefix: string) {
    this.next += 1;
    return `${prefix}-${this.next}`;
  }
  async provisionShopper(input: { openingBalanceCents: number }) {
    const accountRef = this.id("acct");
    this.accounts.set(accountRef, input.openingBalanceCents);
    return { customerRef: this.id("cust"), accountRef };
  }
  async provisionCollectionCustomer() {
    return { customerRef: this.id("cust") };
  }
  async provisionCollectionAccount() {
    const accountRef = this.id("acct");
    this.accounts.set(accountRef, 0);
    return { accountRef };
  }
  async provisionMerchant() {
    return { merchantRef: this.id("merchant") };
  }
  async getBalanceCents(accountRef: string) {
    return this.accounts.get(accountRef) ?? 0;
  }
  readonly bills = new Map<string, BillRecord[]>();
  async getAccountSummary(accountRef: string) {
    return {
      balanceCents: this.accounts.get(accountRef) ?? 0,
      nickname: "Checking",
      maskedNumber: "•••• 0000",
    };
  }
  async provisionBill(input: {
    accountRef: string;
    payee: string;
    amountCents: number;
    dueDate: string;
  }) {
    const billRef = this.id("bill");
    const list = this.bills.get(input.accountRef) ?? [];
    list.push({
      id: billRef,
      payee: input.payee,
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      status: "pending",
    });
    this.bills.set(input.accountRef, list);
    return { billRef };
  }
  async listBills(accountRef: string) {
    return this.bills.get(accountRef) ?? [];
  }
  async listMerchantPurchases(merchantRef: string) {
    return [...this.records.entries()]
      .filter(([, row]) => row.kind === "purchase" && row.to === merchantRef)
      .map(([id, row]) => ({ id, amountCents: row.amountCents, status: row.status, date: "" }));
  }
  async submitDeposit(input: DepositInput) {
    return this.record("deposit", {
      ...input,
      fromAccountRef: input.toAccountRef,
      to: input.toAccountRef,
    });
  }
  async submitBillPayment(input: BillPaymentInput) {
    const outcome = this.record("withdrawal", { ...input, to: input.billRef });
    await this.markBillPaid(input.billRef);
    return outcome;
  }
  async markBillPaid(billRef: string) {
    for (const list of this.bills.values()) {
      for (const bill of list) if (bill.id === billRef) bill.status = "completed";
    }
  }
  private record(
    kind: RecordKind,
    input: { fromAccountRef: string; amountCents: number; correlation: string; to?: string },
  ): SubmitOutcome {
    const providerId = this.id(kind);
    this.records.set(providerId, {
      from: input.fromAccountRef,
      to: input.to ?? "",
      amountCents: input.amountCents,
      status: "completed",
      description: input.correlation,
      kind,
    });
    return { outcome: "accepted", providerId, status: "confirmed", providerStatus: "completed" };
  }
  async submitTransfer(input: TransferInput) {
    return this.record("transfer", { ...input, to: input.toAccountRef });
  }
  async submitPurchase(input: PurchaseInput) {
    return this.record("purchase", { ...input, to: input.merchantRef });
  }
  async observe(_kind: RecordKind, providerId: string): Promise<ObservedOutcome> {
    const row = this.records.get(providerId);
    if (!row) return { found: false };
    return {
      found: true,
      providerId,
      status: row.status === "completed" ? "confirmed" : "pending",
      providerStatus: row.status,
      amountCents: row.amountCents,
    };
  }
  async findByCorrelation(input: {
    kind: "transfer" | "purchase";
    fromAccountRef: string;
    correlation: string;
  }) {
    for (const [providerId, row] of this.records) {
      if (
        row.kind === input.kind &&
        row.from === input.fromAccountRef &&
        row.description === input.correlation
      ) {
        return this.observe(input.kind, providerId);
      }
    }
    return { found: false } as const;
  }
}

afterEach(() => setProviderFactory(null));
afterAll(async () => {
  await closeDb();
});

function useRecordBank() {
  const bank = new RecordOnlyBank();
  setProviderFactory(
    (mode): Providers => ({
      mode,
      banking: bank,
      analytics: new PostgresAnalyticsProvider(getDb()),
      retail: new FixtureRetailProvider(),
    }),
  );
  return bank;
}

async function fundedGroup(s: Awaited<ReturnType<typeof startScenario>>, providers: Providers) {
  const alex = await s.ctx("alex");
  const need = await createNeed(alex.session, alex.shopperId, {
    offerId: await s.offerId(),
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
  });
  const groupId = (await runMatching(providers, alex, need.id)).groups[0]?.id ?? "";
  for (const persona of ["alex", "jordan", "sam", "riley"] as const) {
    await confirmTerms(providers, await s.ctx(persona), groupId, await s.version(groupId));
  }
  return groupId;
}

describe("banking provider without balance effects (observed Nessie behavior)", () => {
  it("derives balances from confirmed records and completes the purchase", async () => {
    const bank = useRecordBank();
    const s = await startScenario();
    const providers = { ...s.providers, banking: bank };
    const groupId = await fundedGroup(s, providers);
    for (const persona of ["alex", "jordan"] as const) {
      await contribute(providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await withdraw(providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    const jordanAccount =
      (
        await getDb().query.shoppers.findFirst({
          where: (table, { eq }) => eq(table.id, s.ids.jordan),
        })
      )?.fundingAccountRef ?? "";
    // Provider balance never moved; the effective balance reflects the contribution and its return.
    expect(await bank.getBalanceCents(jordanAccount)).toBe(10000);
    expect(await effectiveBalanceCents(providers, s.session.id, jordanAccount)).toBe(10000);

    // Auto-replacement offered Casey the slot; Casey, Sam and Riley pay.
    await confirmTerms(providers, await s.ctx("casey"), groupId, await s.version(groupId));
    for (const persona of ["casey", "sam", "riley"] as const) {
      await contribute(providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    let view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
    expect(view.collectionBalanceCents).toBe(6000);

    await purchase(providers, await s.ctx("alex"), groupId, await s.version(groupId));
    view = await s.view(groupId);
    expect(view.status).toBe("purchased");
    expect(view.collectionBalanceCents).toBe(0);
    const alexAccount =
      (
        await getDb().query.shoppers.findFirst({
          where: (table, { eq }) => eq(table.id, s.ids.alex),
        })
      )?.fundingAccountRef ?? "";
    expect(await effectiveBalanceCents(providers, s.session.id, alexAccount)).toBe(8500);
  });

  it("blocks readiness when a provider record no longer matches", async () => {
    const bank = useRecordBank();
    const s = await startScenario();
    const providers = { ...s.providers, banking: bank };
    const groupId = await fundedGroup(s, providers);
    await contribute(providers, await s.ctx("alex"), groupId, await s.version(groupId));
    const [firstRecord] = bank.records.values();
    if (firstRecord) firstRecord.amountCents = 1400;
    for (const persona of ["jordan", "sam", "riley"] as const) {
      await contribute(providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    const view = await s.view(groupId);
    expect(view.status).toBe("funding");
    expect(view.retainedCents).toBe(6000);
  });

  it("provisions sponsor sessions through the configured provider", async () => {
    useRecordBank();
    const { session } = await createSession({ mode: "sponsor" });
    expect(session).toMatchObject({ mode: "sponsor", provisioningStatus: "ready" });
  });
});
