import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { easternDate } from "@/lib/format";
import { mapLimit } from "@/server/concurrency";
import { getDb } from "@/server/db/client";
import { bankOperations } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { type BillRecord, recordKindFor } from "@/server/providers/banking/types";
import type { OperationRow, ShopperRow } from "@/server/services/records";
import type { SessionRow } from "@/server/services/session-service";

/**
 * Balance used for affordability and collection checks. When the provider applies balance effects
 * (rehearsal ledger) its balance is authoritative. Otherwise (observed for Nessie, which records
 * transactions without moving balances) it is the provider's opening balance adjusted by this
 * session's confirmed operations, each of which is backed by a provider record.
 */
export async function effectiveBalanceCents(
  providers: Providers,
  sessionId: string,
  accountRef: string,
  /** Provider balance already read by the caller, to avoid a second read of the same account. */
  reportedBalanceCents?: number,
): Promise<number> {
  const reported = reportedBalanceCents ?? (await providers.banking.getBalanceCents(accountRef));
  if (providers.banking.capabilities.balanceEffects) return reported;
  const rows = await getDb()
    .select({
      from: bankOperations.fromAccountRef,
      to: bankOperations.toRef,
      amountCents: bankOperations.amountCents,
    })
    .from(bankOperations)
    .where(
      and(
        eq(bankOperations.sessionId, sessionId),
        eq(bankOperations.status, "confirmed"),
        or(eq(bankOperations.fromAccountRef, accountRef), eq(bankOperations.toRef, accountRef)),
      ),
    );
  let balance = reported;
  for (const row of rows) {
    if (row.from === accountRef) balance -= row.amountCents;
    if (row.to === accountRef) balance += row.amountCents;
  }
  return balance;
}

/** Bounded parallel reads keep readiness and wallet views fast without flooding the bank API. */
export const PROVIDER_READ_CONCURRENCY = 5;

export type RecordCheck = "verified" | "mismatch" | "missing" | "unresolved";

/** Re-read one operation's provider record and compare its amount and status. */
export async function checkProviderRecord(
  providers: Providers,
  operation: OperationRow,
): Promise<{ check: RecordCheck; providerStatus: string | null }> {
  if (operation.status !== "confirmed") return { check: "unresolved", providerStatus: null };
  if (!operation.providerId) return { check: "missing", providerStatus: null };
  const observed = await providers.banking.observe(
    recordKindFor(operation.kind),
    operation.providerId,
    operation.kind === "deposit" ? operation.toRef : operation.fromAccountRef,
  );
  if (!observed.found) return { check: "missing", providerStatus: null };
  const matches =
    observed.status === "confirmed" &&
    (observed.amountCents === undefined || observed.amountCents === operation.amountCents);
  return { check: matches ? "verified" : "mismatch", providerStatus: observed.providerStatus };
}

/**
 * Re-read every confirmed operation from the provider and confirm the record still exists with
 * the same amount and a completed status. Required before purchase when balances are derived.
 */
export async function verifyProviderRecords(
  providers: Providers,
  operations: OperationRow[],
): Promise<{ ok: boolean; mismatches: string[] }> {
  if (providers.banking.capabilities.balanceEffects) return { ok: true, mismatches: [] };
  const confirmed = operations.filter((operation) => operation.status === "confirmed");
  const checks = await mapLimit(confirmed, PROVIDER_READ_CONCURRENCY, (operation) =>
    checkProviderRecord(providers, operation),
  );
  const mismatches = confirmed
    .filter((_, index) => checks[index]?.check !== "verified")
    .map((operation) => operation.id);
  return { ok: mismatches.length === 0, mismatches };
}

export interface Spendable {
  effectiveBalanceCents: number;
  /** Unpaid bills due on or before the pickup date. */
  billsDueCents: number;
  bills: BillRecord[];
  /** The shopper's personal cushion (stored as `bufferCents`). */
  cushionCents: number;
  /** Outgoing operations not yet resolved (prepared, sending, pending or unknown). */
  pendingOutCents: number;
  spendableCents: number;
}

const UNRESOLVED_STATUSES = ["prepared", "dispatching", "pending", "unknown"] as const;

/** Bills on this account with a payment that is confirmed or still being resolved. */
async function billsWithPayments(sessionId: string, accountRef: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ billRef: bankOperations.toRef, status: bankOperations.status })
    .from(bankOperations)
    .where(
      and(
        eq(bankOperations.sessionId, sessionId),
        eq(bankOperations.kind, "bill_payment"),
        eq(bankOperations.fromAccountRef, accountRef),
      ),
    );
  return new Set(rows.filter((row) => row.status !== "failed").map((row) => row.billRef));
}

/** Money already committed to leave this account but not confirmed either way. */
async function pendingOutflowCents(
  sessionId: string,
  accountRef: string,
  excludeAllocationId: string | null,
): Promise<number> {
  const rows = await getDb()
    .select({ amountCents: bankOperations.amountCents })
    .from(bankOperations)
    .where(
      and(
        eq(bankOperations.sessionId, sessionId),
        eq(bankOperations.fromAccountRef, accountRef),
        inArray(bankOperations.status, [...UNRESOLVED_STATUSES]),
        excludeAllocationId
          ? or(
              isNull(bankOperations.allocationId),
              ne(bankOperations.allocationId, excludeAllocationId),
            )
          : undefined,
      ),
    );
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

const SETTLED_BILLS = new Set(["completed", "cancelled", "canceled", "paid"]);

/**
 * What a shopper can safely contribute: effective balance, minus unpaid bills due by the group's
 * pickup date (read from the bank), minus their personal cushion, minus contributions still
 * waiting on the bank. Balance alone never decides affordability.
 */
export async function spendable(
  providers: Providers,
  session: SessionRow,
  shopper: ShopperRow,
  pickupWindowKey: string | null,
  /** The allocation whose contribution is being checked; its own operation is not a hold. */
  options: { excludeAllocationId?: string; reportedBalanceCents?: number } = {},
): Promise<Spendable | null> {
  if (!shopper.fundingAccountRef) return null;
  const [effective, bills, pendingOutCents, paidBills] = await Promise.all([
    effectiveBalanceCents(
      providers,
      session.id,
      shopper.fundingAccountRef,
      options.reportedBalanceCents,
    ),
    providers.banking.listBills(shopper.fundingAccountRef),
    pendingOutflowCents(session.id, shopper.fundingAccountRef, options.excludeAllocationId ?? null),
    billsWithPayments(session.id, shopper.fundingAccountRef),
  ]);
  const window = session.pickupWindows.find((item) => item.key === pickupWindowKey);
  const cutoff = window ? easternDate(new Date(window.endsAt)) : null;
  const billsDueCents = bills
    .filter((bill) => !SETTLED_BILLS.has(bill.status.toLowerCase()))
    // A bill with a payment on its way is covered by that payment (held or already deducted).
    .filter((bill) => !paidBills.has(bill.id))
    // A bill without a known due date is treated as due: overstating spendable money is worse.
    .filter((bill) => cutoff === null || bill.dueDate === "" || bill.dueDate <= cutoff)
    .reduce((sum, bill) => sum + bill.amountCents, 0);
  return {
    effectiveBalanceCents: effective,
    billsDueCents,
    bills,
    cushionCents: shopper.bufferCents,
    pendingOutCents,
    // Unresolved outflows are held conservatively so a second contribution can't overspend.
    spendableCents: effective - billsDueCents - shopper.bufferCents - pendingOutCents,
  };
}
