import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { demoSessions, rehearsalAccounts, rehearsalTransactions } from "@/server/db/schema";
import type {
  BankingProvider,
  ObservedOutcome,
  SubmitOutcome,
} from "@/server/providers/banking/types";
import { ProviderError } from "@/server/providers/errors";
import { runtime } from "@/server/runtime";

type Fault = "pending" | "unknown" | "reject";

/**
 * Postgres-backed banking simulation with real balance effects. Operators can inject one fault
 * for the next write: leave it pending (settles when observed), lose the response after executing
 * (unknown, recoverable by correlation lookup), or reject it outright.
 */
export class RehearsalBankingProvider implements BankingProvider {
  readonly name = "rehearsal-ledger" as const;
  readonly capabilities = {
    correlationLookup: true,
    amountUnit: "integer cents (local ledger)",
    verified: true,
  };

  constructor(private readonly db: Db) {}

  private async createAccount(
    sessionId: string,
    ownerKind: "shopper" | "collection" | "merchant",
    label: string,
    balanceCents: number,
  ): Promise<string> {
    const id = runtime.newId("rla");
    await this.db
      .insert(rehearsalAccounts)
      .values({ id, sessionId, ownerKind, label, balanceCents });
    return id;
  }

  async provisionShopper(input: {
    sessionId: string;
    displayName: string;
    openingBalanceCents: number;
  }) {
    const accountRef = await this.createAccount(
      input.sessionId,
      "shopper",
      `${input.displayName} checking`,
      input.openingBalanceCents,
    );
    return { customerRef: `local:${input.displayName}`, accountRef };
  }

  async provisionCollectionCustomer() {
    return { customerRef: null };
  }

  async provisionCollectionAccount(input: { sessionId: string; groupId: string }) {
    const accountRef = await this.createAccount(
      input.sessionId,
      "collection",
      `Group ${input.groupId} collection`,
      0,
    );
    return { accountRef };
  }

  async provisionMerchant(input: { sessionId: string; name: string }) {
    const merchantRef = await this.createAccount(input.sessionId, "merchant", input.name, 0);
    return { merchantRef };
  }

  async getBalanceCents(accountRef: string): Promise<number> {
    const [account] = await this.db
      .select({ balanceCents: rehearsalAccounts.balanceCents })
      .from(rehearsalAccounts)
      .where(eq(rehearsalAccounts.id, accountRef));
    if (!account) throw new ProviderError("rehearsal-ledger", "Account not found", 404);
    return account.balanceCents;
  }

  private async takeFault(sessionId: string): Promise<Fault | null> {
    const result = await this.db.execute<{ fault: Fault | null }>(sql`
      with previous as (
        select id, rehearsal_fault as fault from ${demoSessions} where id = ${sessionId} for update
      )
      update ${demoSessions} set rehearsal_fault = null
      from previous where ${demoSessions.id} = previous.id
      returning previous.fault as fault
    `);
    return result.rows[0]?.fault ?? null;
  }

  private async move(
    kind: "transfer" | "purchase",
    input: {
      sessionId: string;
      fromAccountRef: string;
      toRef: string;
      amountCents: number;
      description: string;
    },
  ): Promise<SubmitOutcome> {
    const fault = await this.takeFault(input.sessionId);
    if (fault === "reject") {
      return { outcome: "rejected", code: "REHEARSAL_REJECTED", message: "Injected rejection" };
    }
    const pending = fault === "pending";
    const id = runtime.newId("rtx");
    const result = await this.db.transaction(async (tx) => {
      const accounts = await tx
        .select()
        .from(rehearsalAccounts)
        .where(eq(rehearsalAccounts.sessionId, input.sessionId))
        .for("update");
      const payer = accounts.find((account) => account.id === input.fromAccountRef);
      const payee = accounts.find((account) => account.id === input.toRef);
      if (!payer || !payee) return "missing_account" as const;
      if (!pending && payer.balanceCents < input.amountCents) return "insufficient" as const;
      await tx.insert(rehearsalTransactions).values({
        id,
        sessionId: input.sessionId,
        kind,
        payerAccountId: payer.id,
        payeeAccountId: payee.id,
        amountCents: input.amountCents,
        status: pending ? "pending" : "executed",
        description: input.description,
        settledAt: pending ? null : runtime.now(),
      });
      if (!pending) {
        await applyBalances(tx, payer.id, payee.id, input.amountCents);
      }
      return "ok" as const;
    });
    if (result === "missing_account") {
      return { outcome: "rejected", code: "ACCOUNT_NOT_FOUND", message: "Account not found" };
    }
    if (result === "insufficient") {
      return { outcome: "rejected", code: "INSUFFICIENT_FUNDS", message: "Insufficient funds" };
    }
    if (fault === "unknown") {
      return {
        outcome: "unknown",
        code: "RESPONSE_LOST",
        message: "Injected lost response after execution",
      };
    }
    return {
      outcome: "accepted",
      providerId: id,
      status: pending ? "pending" : "confirmed",
      providerStatus: pending ? "pending" : "executed",
    };
  }

  submitTransfer(input: Parameters<BankingProvider["submitTransfer"]>[0]) {
    return this.move("transfer", { ...input, toRef: input.toAccountRef });
  }

  submitPurchase(input: Parameters<BankingProvider["submitPurchase"]>[0]) {
    return this.move("purchase", { ...input, toRef: input.merchantRef });
  }

  /** Observing a pending rehearsal transaction settles it, simulating asynchronous processing. */
  async observe(_kind: "transfer" | "purchase", providerId: string): Promise<ObservedOutcome> {
    return this.db.transaction(async (tx) => {
      const [txn] = await tx
        .select()
        .from(rehearsalTransactions)
        .where(eq(rehearsalTransactions.id, providerId))
        .for("update");
      if (!txn) return { found: false };
      if (txn.status === "pending") {
        const [payer] = await tx
          .select()
          .from(rehearsalAccounts)
          .where(eq(rehearsalAccounts.id, txn.payerAccountId))
          .for("update");
        const executable = (payer?.balanceCents ?? 0) >= txn.amountCents;
        await tx
          .update(rehearsalTransactions)
          .set({ status: executable ? "executed" : "cancelled", settledAt: runtime.now() })
          .where(eq(rehearsalTransactions.id, txn.id));
        if (executable)
          await applyBalances(tx, txn.payerAccountId, txn.payeeAccountId, txn.amountCents);
        return {
          found: true,
          providerId: txn.id,
          status: executable ? "confirmed" : "failed",
          providerStatus: executable ? "executed" : "cancelled",
        };
      }
      return {
        found: true,
        providerId: txn.id,
        status: txn.status === "executed" ? "confirmed" : "failed",
        providerStatus: txn.status,
      };
    });
  }

  async findByCorrelation(input: {
    kind: "transfer" | "purchase";
    fromAccountRef: string;
    correlation: string;
  }): Promise<ObservedOutcome> {
    const [txn] = await this.db
      .select({ id: rehearsalTransactions.id })
      .from(rehearsalTransactions)
      .where(
        and(
          eq(rehearsalTransactions.kind, input.kind),
          eq(rehearsalTransactions.payerAccountId, input.fromAccountRef),
          eq(rehearsalTransactions.description, input.correlation),
        ),
      );
    if (!txn) return { found: false };
    return this.observe(input.kind, txn.id);
  }
}

async function applyBalances(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  payerId: string,
  payeeId: string,
  amountCents: number,
) {
  await tx
    .update(rehearsalAccounts)
    .set({ balanceCents: sql`${rehearsalAccounts.balanceCents} - ${amountCents}` })
    .where(eq(rehearsalAccounts.id, payerId));
  await tx
    .update(rehearsalAccounts)
    .set({ balanceCents: sql`${rehearsalAccounts.balanceCents} + ${amountCents}` })
    .where(eq(rehearsalAccounts.id, payeeId));
}
