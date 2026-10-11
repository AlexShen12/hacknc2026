import { and, desc, eq, inArray, or } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { easternDate, formatPickupWindow } from "@/lib/format";
import type { LedgerEntryView, WalletView } from "@/lib/view-types";
import { mapLimit } from "@/server/concurrency";
import { getDb } from "@/server/db/client";
import { allocations, bankOperations, groups, shoppers } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import {
  checkProviderRecord,
  PROVIDER_READ_CONCURRENCY,
  spendable,
} from "@/server/services/balance-service";
import { OUTSIDE_ACCOUNT } from "@/server/providers/banking/types";
import {
  type ActionContext,
  dispatchOperation,
  prepareOperation,
} from "@/server/services/funding-service";
import { appendSessionEvent, type OperationRow } from "@/server/services/records";
import { getShopper, type SessionRow } from "@/server/services/session-service";

/**
 * Every money movement touching an account in this session, newest first, each re-read from the
 * bank by its provider record ID so the page shows what the bank itself recorded.
 */
export async function accountLedger(
  providers: Providers,
  session: SessionRow,
  accountRef: string,
  limit = 25,
): Promise<LedgerEntryView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(bankOperations)
    .where(
      and(
        eq(bankOperations.sessionId, session.id),
        or(eq(bankOperations.fromAccountRef, accountRef), eq(bankOperations.toRef, accountRef)),
      ),
    )
    .orderBy(desc(bankOperations.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const groupIds = [...new Set(rows.map((row) => row.groupId).filter((id): id is string => !!id))];
  const groupRows = groupIds.length
    ? await db
        .select({ id: groups.id, snapshot: groups.offerSnapshot })
        .from(groups)
        .where(inArray(groups.id, groupIds))
    : [];
  const productByGroup = new Map(groupRows.map((row) => [row.id, `${row.snapshot.productName}`]));
  const allocationIds = rows.map((row) => row.allocationId).filter((id): id is string => !!id);
  const owners = allocationIds.length
    ? await db
        .select({ id: allocations.id, name: shoppers.displayName })
        .from(allocations)
        .innerJoin(shoppers, eq(shoppers.id, allocations.shopperId))
        .where(inArray(allocations.id, allocationIds))
    : [];
  const ownerByAllocation = new Map(owners.map((row) => [row.id, row.name]));

  const checks = await mapLimit(rows, PROVIDER_READ_CONCURRENCY, async (row) => {
    try {
      return await checkProviderRecord(providers, row);
    } catch {
      return { check: "unavailable" as const, providerStatus: null };
    }
  });
  const entries: LedgerEntryView[] = rows.map((row, index) => {
    const result = checks[index];
    return {
      operationId: row.id,
      kind: row.kind,
      direction: row.fromAccountRef === accountRef ? "out" : "in",
      amountCents: row.amountCents,
      status: row.status,
      groupId: row.groupId,
      billRef: row.kind === "bill_payment" ? row.toRef : null,
      label:
        row.kind === "deposit"
          ? "Wallet top-up"
          : row.kind === "bill_payment"
            ? "Bill payment"
            : (productByGroup.get(row.groupId ?? "") ?? "Group"),
      shopperName: row.allocationId ? (ownerByAllocation.get(row.allocationId) ?? null) : null,
      providerId: row.providerId,
      providerStatus: result?.providerStatus ?? row.providerStatus,
      check: result?.check ?? "unresolved",
      createdAt: row.createdAt.toISOString(),
    };
  });
  return entries;
}

/** The selected shopper's bank view: balance, bills, what they can spend, and verified history. */
export async function getWallet(
  providers: Providers,
  session: SessionRow,
  shopperId: string,
): Promise<WalletView> {
  const shopper = await getShopper(session.id, shopperId);
  if (!shopper.fundingAccountRef) {
    throw new DomainError("UPSTREAM_UNAVAILABLE", "This shopper's bank account is not set up yet.");
  }
  const nextWindow = [...session.pickupWindows].sort((a, b) =>
    a.startsAt < b.startsAt ? -1 : 1,
  )[0];
  // One balance read: the summary's balance also feeds the effective and spendable figures.
  const [summary, activity] = await Promise.all([
    providers.banking.getAccountSummary(shopper.fundingAccountRef),
    accountLedger(providers, session, shopper.fundingAccountRef),
  ]);
  const money = await spendable(providers, session, shopper, nextWindow?.key ?? null, {
    reportedBalanceCents: summary.balanceCents,
  });
  if (!money) throw new DomainError("UPSTREAM_UNAVAILABLE", "Balance unavailable.");
  const cutoff = nextWindow ? easternDate(new Date(nextWindow.endsAt)) : null;
  return {
    shopperId,
    name: shopper.displayName,
    provider: providers.banking.name,
    balanceEffects: providers.banking.capabilities.balanceEffects,
    account: {
      nickname: summary.nickname,
      maskedNumber: summary.maskedNumber,
      providerBalanceCents: summary.balanceCents,
    },
    effectiveBalanceCents: money.effectiveBalanceCents,
    billsDueCents: money.billsDueCents,
    cushionCents: money.cushionCents,
    pendingOutCents: money.pendingOutCents,
    spendableCents: money.spendableCents,
    nextPickupLabel: nextWindow ? formatPickupWindow(nextWindow.startsAt, nextWindow.endsAt) : null,
    bills: money.bills.map((bill) => ({
      id: bill.id,
      payment:
        activity.find((entry) => entry.kind === "bill_payment" && entry.billRef === bill.id)
          ?.status ?? null,
      payee: bill.payee,
      amountCents: bill.amountCents,
      dueDate: bill.dueDate,
      status: bill.status,
      dueBeforePickup: bill.dueDate === "" || (cutoff !== null && bill.dueDate <= cutoff),
    })),
    activity,
  };
}

/**
 * The group's collection account and each of its records, re-read from the bank. Only people who
 * hold (or held) a share in the group may see who contributed what.
 */
export async function groupLedger(
  providers: Providers,
  session: SessionRow,
  groupId: string,
  viewerShopperId: string | null,
) {
  const [group] = await getDb()
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.sessionId, session.id)));
  if (!group) throw new DomainError("NOT_FOUND", "Group not found.");
  const [membership] = viewerShopperId
    ? await getDb()
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.groupId, groupId), eq(allocations.shopperId, viewerShopperId)))
        .limit(1)
    : [];
  if (!membership) {
    throw new DomainError("NOT_AUTHORIZED", "Only members can see this group's money movements.");
  }
  if (!group.collectionAccountRef) {
    return {
      account: null,
      entries: [],
      verified: 0,
      confirmed: 0,
      provider: providers.banking.name,
    };
  }
  const [summary, entries] = await Promise.all([
    providers.banking.getAccountSummary(group.collectionAccountRef),
    accountLedger(providers, session, group.collectionAccountRef, 50),
  ]);
  return {
    account: { nickname: summary.nickname, maskedNumber: summary.maskedNumber },
    entries,
    verified: entries.filter((entry) => entry.check === "verified").length,
    confirmed: entries.filter((entry) => entry.status === "confirmed").length,
    provider: providers.banking.name,
  };
}

const MIN_TOP_UP_CENTS = 100;
const MAX_TOP_UP_CENTS = 50_000;

/**
 * Add mock funds to the selected shopper's account as a bank deposit. `requestKey` makes a
 * double-submitted form create one deposit; the operation is persisted before it is sent.
 */
export async function addFunds(
  providers: Providers,
  ctx: ActionContext,
  input: { amountCents: number; requestKey: string },
): Promise<OperationRow> {
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents < MIN_TOP_UP_CENTS ||
    input.amountCents > MAX_TOP_UP_CENTS
  ) {
    throw new DomainError("INVALID_INPUT", "Add between $1.00 and $500.00.", {
      fields: { amount: "Add between $1.00 and $500.00." },
    });
  }
  const shopper = await getShopper(ctx.session.id, ctx.shopperId);
  if (!shopper.fundingAccountRef) {
    throw new DomainError("UPSTREAM_UNAVAILABLE", "This shopper's bank account is not set up yet.");
  }
  const accountRef = shopper.fundingAccountRef;
  const operation = await getDb().transaction(async (tx) => {
    const created = await prepareOperation(tx, {
      sessionId: ctx.session.id,
      groupId: null,
      shopperId: shopper.id,
      allocationId: null,
      kind: "deposit",
      operationKey: `deposit:${shopper.id}:${input.requestKey}`,
      amountCents: input.amountCents,
      fromAccountRef: OUTSIDE_ACCOUNT,
      toRef: accountRef,
    });
    await appendSessionEvent(tx, {
      sessionId: ctx.session.id,
      actor: ctx.actor,
      type: "deposit_requested",
      payload: { operationId: created.id, amountCents: created.amountCents },
    });
    return created;
  });
  if (operation.status === "prepared") return dispatchOperation(providers, operation.id);
  return operation;
}

/**
 * Pay one of the shopper's bills from their account: a payment record at the bank plus the bill
 * marked paid. One payment per bill; a repeated request returns the existing one.
 */
export async function payBill(
  providers: Providers,
  ctx: ActionContext,
  billRef: string,
): Promise<OperationRow> {
  const shopper = await getShopper(ctx.session.id, ctx.shopperId);
  if (!shopper.fundingAccountRef) {
    throw new DomainError("UPSTREAM_UNAVAILABLE", "This shopper's bank account is not set up yet.");
  }
  const accountRef = shopper.fundingAccountRef;
  const bill = (await providers.banking.listBills(accountRef)).find((item) => item.id === billRef);
  if (!bill) throw new DomainError("NOT_FOUND", "Bill not found on your account.");
  const operationKey = `bill_payment:${billRef}`;
  const [existing] = await getDb()
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.operationKey, operationKey));
  if (existing && existing.status !== "failed") return existing;
  if (["completed", "paid"].includes(bill.status.toLowerCase())) {
    throw new DomainError("INCOMPATIBLE_STATE", "This bill is already paid.");
  }
  // Paying a bill needs the money now (the personal cushion may be used for bills).
  const money = await spendable(providers, ctx.session, shopper, null);
  const available = (money?.effectiveBalanceCents ?? 0) - (money?.pendingOutCents ?? 0);
  if (available < bill.amountCents) {
    throw new DomainError("INSUFFICIENT_FUNDS", "There isn't enough in the account to pay this bill.");
  }
  const operation = await getDb().transaction(async (tx) => {
    const created = await prepareOperation(tx, {
      sessionId: ctx.session.id,
      groupId: null,
      shopperId: shopper.id,
      allocationId: null,
      kind: "bill_payment",
      operationKey,
      amountCents: bill.amountCents,
      fromAccountRef: accountRef,
      toRef: billRef,
    });
    if (created.status === "failed") {
      // Explicit retry of a definitively rejected payment.
      const [retried] = await tx
        .update(bankOperations)
        .set({ status: "prepared", updatedAt: new Date() })
        .where(and(eq(bankOperations.id, created.id), eq(bankOperations.status, "failed")))
        .returning();
      if (retried) return retried;
    }
    await appendSessionEvent(tx, {
      sessionId: ctx.session.id,
      actor: ctx.actor,
      type: "bill_payment_requested",
      payload: { operationId: created.id, amountCents: created.amountCents, payee: bill.payee },
    });
    return created;
  });
  if (operation.status === "prepared") return dispatchOperation(providers, operation.id);
  return operation;
}
