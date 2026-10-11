import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { readinessBlockers } from "@/domain/funding";
import { isOfferOpen } from "@/domain/matching";
import { formatCents } from "@/domain/money";
import type { GroupStatus, OperationKind, OperationStatus } from "@/domain/types";
import { getDb, type Tx } from "@/server/db/client";
import {
  allocations,
  bankOperations,
  groups,
  needs,
  operationAttempts,
  workflowEvents,
} from "@/server/db/schema";
import { log } from "@/server/observability/logger";
import type { Providers } from "@/server/providers";
import {
  type ObservedOutcome,
  operationDescription,
  recordKindFor,
  type SubmitOutcome,
} from "@/server/providers/banking/types";
import { runtime } from "@/server/runtime";
import {
  effectiveBalanceCents,
  spendable,
  verifyProviderRecords,
} from "@/server/services/balance-service";
import {
  currentMembers,
  type GroupBundle,
  hasPendingReplacement,
  loadBundleFor,
  operationById,
  toFundingAllocations,
  vacantAllocations,
} from "@/server/services/group-view";
import { notify } from "@/server/services/notification-service";
import {
  appendGroupEvent,
  appendSessionEvent,
  assertVersion,


  lockGroup,
  type OperationRow,
  toOfferTerms,
} from "@/server/services/records";
import { getShopper, type SessionRow } from "@/server/services/session-service";

export interface ActionContext {
  session: SessionRow;
  shopperId: string;
  /** Event actor label, e.g. the shopper ID or `demo:<shopperId>`. */
  actor: string;
  demoControl?: boolean;
}

const STALE_DISPATCH_MS = 30_000;

/** Persist one logical operation. A duplicate key returns the existing operation. */
export async function prepareOperation(
  tx: Tx,
  input: {
    sessionId: string;
    /** Null for wallet operations (top-ups, bill payments). */
    groupId: string | null;
    shopperId?: string | null;
    allocationId: string | null;
    kind: OperationKind;
    operationKey: string;
    amountCents: number;
    fromAccountRef: string;
    toRef: string;
    relatedOperationId?: string | null;
  },
): Promise<OperationRow> {
  const [created] = await tx
    .insert(bankOperations)
    .values({
      id: runtime.newId("op"),
      sessionId: input.sessionId,
      groupId: input.groupId,
      shopperId: input.shopperId ?? null,
      allocationId: input.allocationId,
      kind: input.kind,
      operationKey: input.operationKey,
      amountCents: input.amountCents,
      fromAccountRef: input.fromAccountRef,
      toRef: input.toRef,
      status: "prepared",
      relatedOperationId: input.relatedOperationId ?? null,
      createdAt: runtime.now(),
      updatedAt: runtime.now(),
    })
    .onConflictDoNothing({ target: bankOperations.operationKey })
    .returning();
  if (created) {
    return created;
  }
  const [existing] = await tx
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.operationKey, input.operationKey));
  if (!existing) throw new Error("Operation insert conflict without existing row");
  return existing;
}

function statusFromSubmit(outcome: SubmitOutcome): OperationStatus {
  if (outcome.outcome === "accepted") return outcome.status;
  return outcome.outcome === "rejected" ? "failed" : "unknown";
}

/**
 * Claim a prepared operation, call the provider outside any transaction, then record the outcome.
 * Only one caller can win the claim; others observe the current state.
 */
export async function dispatchOperation(
  providers: Providers,
  operationId: string,
): Promise<OperationRow> {
  const db = getDb();
  const claimed = await db.transaction(async (tx) => {
    const [operation] = await tx
      .update(bankOperations)
      .set({
        status: "dispatching",
        attemptCount: sql`${bankOperations.attemptCount} + 1`,
        revision: sql`${bankOperations.revision} + 1`,
        updatedAt: runtime.now(),
      })
      .where(and(eq(bankOperations.id, operationId), eq(bankOperations.status, "prepared")))
      .returning();
    if (!operation) return null;
    await tx.insert(operationAttempts).values({
      id: runtime.newId("att"),
      operationId: operation.id,
      attemptNumber: operation.attemptCount,
      startedAt: runtime.now(),
    });
    return operation;
  });
  if (!claimed) {
    const [current] = await db
      .select()
      .from(bankOperations)
      .where(eq(bankOperations.id, operationId));
    if (!current) throw new DomainError("NOT_FOUND", "Operation not found.");
    return current;
  }

  const description = operationDescription(claimed.operationKey);
  let outcome: SubmitOutcome;
  const started = Date.now();
  try {
    outcome = await submitToProvider(providers, claimed, description);
  } catch (error) {
    outcome = { outcome: "unknown", code: "ADAPTER_ERROR", message: String(error).slice(0, 300) };
  }
  log(outcome.outcome === "accepted" ? "info" : "warn", "bank.dispatch", {
    sessionId: claimed.sessionId,
    groupId: claimed.groupId,
    operationId: claimed.id,
    kind: claimed.kind,
    provider: providers.banking.name,
    outcome: outcome.outcome,
    durationMs: Date.now() - started,
  });

  const status = statusFromSubmit(outcome);
  return db.transaction(async (tx) => {
    if (claimed.groupId) await lockGroup(tx, claimed.sessionId, claimed.groupId);
    const error =
      outcome.outcome === "accepted"
        ? null
        : { code: outcome.code, message: outcome.message, httpStatus: outcome.httpStatus };
    const [recorded] = await tx
      .update(bankOperations)
      .set({
        status,
        providerId: outcome.outcome === "accepted" ? outcome.providerId : null,
        providerStatus: outcome.outcome === "accepted" ? outcome.providerStatus : null,
        lastError: error,
        revision: sql`${bankOperations.revision} + 1`,
        updatedAt: runtime.now(),
      })
      .where(and(eq(bankOperations.id, claimed.id), eq(bankOperations.status, "dispatching")))
      .returning();
    await tx
      .update(operationAttempts)
      .set({
        finishedAt: runtime.now(),
        outcome: outcome.outcome,
        providerId: outcome.outcome === "accepted" ? outcome.providerId : null,
        error,
      })
      .where(
        and(
          eq(operationAttempts.operationId, claimed.id),
          eq(operationAttempts.attemptNumber, claimed.attemptCount),
        ),
      );
    if (!recorded) {
      const [current] = await tx
        .select()
        .from(bankOperations)
        .where(eq(bankOperations.id, claimed.id));
      if (!current) throw new Error("Operation vanished");
      return current;
    }
    await notifyOperationOutcome(tx, recorded);
    await operationEvent(tx, recorded, `${recorded.kind}_${status}`, {
      operationId: recorded.id,
      amountCents: recorded.amountCents,
      providerId: recorded.providerId,
      error: error?.code,
    });
    return recorded;
  });
}

/**
 * Observe an unresolved operation through the provider. Never resubmits. Without a provider ID
 * and without a verified correlation lookup, the operation stays unknown for the operator.
 */
export async function reconcileOperation(
  providers: Providers,
  session: SessionRow,
  operationId: string,
): Promise<OperationRow> {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(bankOperations)
    .where(and(eq(bankOperations.id, operationId), eq(bankOperations.sessionId, session.id)));
  if (!operation) throw new DomainError("NOT_FOUND", "Operation not found.");

  const advance = () =>
    operation.groupId ? advanceGroup(providers, session, operation.groupId) : Promise.resolve();
  if (operation.status === "prepared") {
    // Never sent, so dispatching is the first attempt rather than a retry.
    await dispatchOperation(providers, operation.id);
    await advance();
    return reloadOperation(operation.id);
  }
  const staleDispatch =
    operation.status === "dispatching" &&
    runtime.now().getTime() - operation.updatedAt.getTime() > STALE_DISPATCH_MS;
  if (operation.status !== "pending" && operation.status !== "unknown" && !staleDispatch) {
    await advance();
    return reloadOperation(operation.id);
  }

  const kind = recordKindFor(operation.kind);
  const listedOn = recordAccountFor(operation);
  let observed: ObservedOutcome;
  let method: "provider_id" | "correlation" | "none";
  if (operation.providerId) {
    method = "provider_id";
    observed = await providers.banking.observe(kind, operation.providerId, listedOn);
  } else if (providers.banking.capabilities.correlationLookup) {
    method = "correlation";
    observed = await providers.banking.findByCorrelation({
      kind,
      fromAccountRef: listedOn,
      correlation: operationDescription(operation.operationKey),
    });
  } else {
    method = "none";
    observed = { found: false };
  }

  const settled = await db.transaction(async (tx) => {
    if (operation.groupId) await lockGroup(tx, session.id, operation.groupId);
    let status: OperationStatus | null = null;
    let providerId = operation.providerId;
    let providerStatus = operation.providerStatus;
    let lastError = operation.lastError;
    if (observed.found) {
      status = observed.status;
      providerId = observed.providerId;
      providerStatus = observed.providerStatus;
      if (observed.status === "failed") {
        lastError = { code: "PROVIDER_FAILED", message: observed.providerStatus };
      }
    } else if (
      method === "correlation" &&
      providers.banking.capabilities.correlationAbsenceIsProof &&
      !staleDispatch
    ) {
      // Only an authoritative ledger's "not found" proves the write never executed. A stale
      // dispatch may still land, so it is never concluded as failed from absence alone.
      status = "failed";
      lastError = { code: "NOT_EXECUTED", message: "No matching provider transaction found" };
    } else if (staleDispatch) {
      status = "unknown";
      lastError = { code: "DISPATCH_INTERRUPTED", message: "Dispatch did not record an outcome" };
    }
    if (status && status !== operation.status) {
      const [updated] = await tx
        .update(bankOperations)
        .set({
          status,
          providerId,
          providerStatus,
          lastError,
          revision: sql`${bankOperations.revision} + 1`,
          updatedAt: runtime.now(),
        })
        .where(
          and(eq(bankOperations.id, operation.id), eq(bankOperations.status, operation.status)),
        )
        .returning();
      if (updated) {
        await notifyOperationOutcome(tx, updated);
      }
    }
    await operationEvent(
      tx,
      operation,
      status ? "operation_reconciled" : "reconciliation_needs_operator",
      { operationId: operation.id, method, status: status ?? operation.status },
    );
    return status;
  });
  // A confirmed bill payment's bill must read as paid; the update is idempotent and safe to repeat.
  if (operation.kind === "bill_payment" && settled === "confirmed") {
    await providers.banking.markBillPaid(operation.toRef).catch(() => undefined);
  }
  await advance();
  return reloadOperation(operation.id);
}

/** Send one persisted operation to the provider using the record type for its kind. */
function submitToProvider(
  providers: Providers,
  operation: OperationRow,
  description: string,
): Promise<SubmitOutcome> {
  const common = {
    sessionId: operation.sessionId,
    correlation: description,
    amountCents: operation.amountCents,
    description,
  };
  switch (operation.kind) {
    case "purchase":
      return providers.banking.submitPurchase({
        ...common,
        fromAccountRef: operation.fromAccountRef,
        merchantRef: operation.toRef,
      });
    case "deposit":
      return providers.banking.submitDeposit({ ...common, toAccountRef: operation.toRef });
    case "bill_payment":
      return providers.banking.submitBillPayment({
        ...common,
        fromAccountRef: operation.fromAccountRef,
        billRef: operation.toRef,
      });
    default:
      return providers.banking.submitTransfer({
        ...common,
        fromAccountRef: operation.fromAccountRef,
        toAccountRef: operation.toRef,
      });
  }
}

/** The account a provider lists this operation's record on: the receiver for deposits. */
export function recordAccountFor(operation: OperationRow): string {
  return operation.kind === "deposit" ? operation.toRef : operation.fromAccountRef;
}

/** Group operations log to the group's history; wallet operations to the session's. */
async function operationEvent(
  tx: Tx,
  operation: OperationRow,
  type: string,
  payload: Record<string, unknown>,
) {
  if (operation.groupId) {
    await appendGroupEvent(tx, {
      sessionId: operation.sessionId,
      groupId: operation.groupId,
      actor: "system",
      type,
      payload,
    });
  } else {
    await appendSessionEvent(tx, {
      sessionId: operation.sessionId,
      actor: "system",
      type,
      payload: { ...payload, shopperId: operation.shopperId },
    });
  }
}

async function reloadOperation(operationId: string): Promise<OperationRow> {
  const [row] = await getDb()
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.id, operationId));
  if (!row) throw new DomainError("NOT_FOUND", "Operation not found.");
  return row;
}

const WALLET_MESSAGES: Record<
  "deposit" | "bill_payment",
  Partial<Record<OperationStatus, (amount: string) => string>>
> = {
  deposit: {
    confirmed: (amount) => `${amount} was added to your account.`,
    pending: (amount) => `Your ${amount} top-up is pending at the bank.`,
    failed: (amount) => `Your ${amount} top-up didn't go through.`,
    unknown: (amount) => `We couldn't confirm your ${amount} top-up yet. It won't be resent.`,
  },
  bill_payment: {
    confirmed: (amount) => `Your ${amount} bill payment is confirmed.`,
    pending: (amount) => `Your ${amount} bill payment is pending at the bank.`,
    failed: (amount) => `Your ${amount} bill payment didn't go through.`,
    unknown: (amount) => `We couldn't confirm your ${amount} bill payment yet. It won't be resent.`,
  },
};

const OPERATION_MESSAGES: Record<
  "contribution" | "return",
  Partial<Record<OperationStatus, (amount: string) => string>>
> = {
  contribution: {
    confirmed: (amount) => `Your ${amount} contribution is confirmed.`,
    pending: (amount) => `Your ${amount} contribution is pending at the bank.`,
    failed: (amount) => `Your ${amount} contribution didn't go through. You can try again.`,
    unknown: (amount) =>
      `We couldn't confirm your ${amount} contribution. It won't be resent automatically.`,
  },
  return: {
    confirmed: (amount) => `Your ${amount} contribution was returned to you.`,
    pending: (amount) => `Your ${amount} return is pending at the bank.`,
    failed: (amount) => `Returning your ${amount} failed. The organizer has been alerted.`,
    unknown: (amount) => `We're checking on your ${amount} return.`,
  },
};

/** Tell the affected shopper (and the organizer for problems) what happened to their money. */
async function notifyOperationOutcome(tx: Tx, operation: OperationRow): Promise<void> {
  const amount = formatCents(operation.amountCents);
  if (operation.kind === "deposit" || operation.kind === "bill_payment") {
    const message = WALLET_MESSAGES[operation.kind][operation.status];
    if (message && operation.shopperId) {
      await notify(tx, {
        sessionId: operation.sessionId,
        shopperIds: [operation.shopperId],
        groupId: null,
        kind: `${operation.kind}_${operation.status}`,
        message: message(amount),
      });
    }
    return;
  }
  if (!operation.groupId) return;
  const [group] = await tx.select().from(groups).where(eq(groups.id, operation.groupId));
  if (!group) return;
  const problem = operation.status === "failed" || operation.status === "unknown";
  if (operation.kind === "purchase") {
    if (problem && group.organizerShopperId) {
      await notify(tx, {
        sessionId: operation.sessionId,
        shopperIds: [group.organizerShopperId],
        groupId: group.id,
        kind: `purchase_${operation.status}`,
        message:
          operation.status === "failed"
            ? `The ${amount} purchase was not accepted. You can try again.`
            : `We couldn't confirm the ${amount} purchase. Check its status before retrying.`,
      });
    }
    return;
  }
  const message = OPERATION_MESSAGES[operation.kind][operation.status];
  const [allocation] = operation.allocationId
    ? await tx.select().from(allocations).where(eq(allocations.id, operation.allocationId))
    : [];
  if (!message || !allocation) return;
  const recipients = [allocation.shopperId];
  if (problem && group.organizerShopperId) recipients.push(group.organizerShopperId);
  await notify(tx, {
    sessionId: operation.sessionId,
    shopperIds: recipients,
    groupId: group.id,
    kind: `${operation.kind}_${operation.status}`,
    message: message(amount),
  });
}

/** Create the group's zero-balance collection account once; a lost race leaves an unused account. */
export async function ensureCollectionAccount(
  providers: Providers,
  session: SessionRow,
  groupId: string,
): Promise<string> {
  const db = getDb();
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) throw new DomainError("NOT_FOUND", "Group not found.");
  if (group.collectionAccountRef) return group.collectionAccountRef;
  const { accountRef } = await providers.banking.provisionCollectionAccount({
    sessionId: session.id,
    groupId,
    customerRef: session.collectionCustomerRef,
  });
  const [updated] = await db
    .update(groups)
    .set({ collectionAccountRef: accountRef })
    .where(and(eq(groups.id, groupId), isNull(groups.collectionAccountRef)))
    .returning({ ref: groups.collectionAccountRef });
  if (updated?.ref) return updated.ref;
  const [current] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!current?.collectionAccountRef) throw new Error("Collection account missing");
  return current.collectionAccountRef;
}

/** Return every need still reserved by this group to `status` (open demand or fulfilled). */
export async function releaseNeeds(tx: Tx, groupId: string, status: "forming" | "fulfilled") {
  const released = await tx
    .update(needs)
    .set({
      status,
      reservedGroupId: null,
      revision: sql`${needs.revision} + 1`,
      updatedAt: runtime.now(),
    })
    .where(and(eq(needs.reservedGroupId, groupId), eq(needs.status, "reserved")))
    .returning();
}

/** Create return operations for every confirmed contribution that has not been returned. */
async function prepareReturns(tx: Tx, bundle: GroupBundle, onlyAllocationIds?: Set<string>) {
  let changed = false;
  for (const allocation of bundle.allocations) {
    if (onlyAllocationIds && !onlyAllocationIds.has(allocation.id)) continue;
    const contribution = operationById(bundle, allocation.contributionOperationId);
    if (contribution?.status !== "confirmed" || allocation.returnOperationId) continue;
    if (!bundle.group.collectionAccountRef)
      throw new Error("Collection account missing for return");
    const operation = await prepareOperation(tx, {
      sessionId: bundle.group.sessionId,
      groupId: bundle.group.id,
      allocationId: allocation.id,
      kind: "return",
      operationKey: `return:${allocation.id}`,
      amountCents: contribution.amountCents,
      fromAccountRef: bundle.group.collectionAccountRef,
      toRef: contribution.fromAccountRef,
      relatedOperationId: contribution.id,
    });
    await tx
      .update(allocations)
      .set({ returnOperationId: operation.id, updatedAt: runtime.now() })
      .where(eq(allocations.id, allocation.id));
    changed = true;
  }
  return changed;
}

/** Fail operations that were persisted but never claimed for dispatch. */
async function abandonPreparedContributions(
  tx: Tx,
  bundle: GroupBundle,
  allocationIds?: Set<string>,
) {
  for (const allocation of bundle.allocations) {
    if (allocationIds && !allocationIds.has(allocation.id)) continue;
    const contribution = operationById(bundle, allocation.contributionOperationId);
    if (contribution?.status !== "prepared") continue;
    const [updated] = await tx
      .update(bankOperations)
      .set({
        status: "failed",
        lastError: { code: "CANCELLED_BEFORE_DISPATCH", message: "Not sent to the bank" },
        revision: sql`${bankOperations.revision} + 1`,
        updatedAt: runtime.now(),
      })
      .where(and(eq(bankOperations.id, contribution.id), eq(bankOperations.status, "prepared")))
      .returning();
  }
}

export async function setGroupStatus(
  tx: Tx,
  bundle: GroupBundle,
  status: GroupStatus,
  actor: string,
  reason: string | null = null,
): Promise<void> {
  const from = bundle.group.status;
  const [updated] = await tx
    .update(groups)
    .set({
      status,
      statusReason: reason,
      version: sql`${groups.version} + 1`,
      updatedAt: runtime.now(),
    })
    .where(eq(groups.id, bundle.group.id))
    .returning();
  if (!updated) throw new Error("Group update failed");
  bundle.group = updated;
  await appendGroupEvent(tx, {
    sessionId: updated.sessionId,
    groupId: updated.id,
    actor,
    type: "status_changed",
    payload: { from, to: status, reason },
  });
  await notifyStatusChange(tx, bundle, from, status);
}

async function notifyStatusChange(
  tx: Tx,
  bundle: GroupBundle,
  from: GroupStatus,
  to: GroupStatus,
): Promise<void> {
  const product = bundle.group.offerSnapshot.productName;
  const members = currentMembers(bundle.allocations).map((row) => row.shopperId);
  const everyone = bundle.allocations.map((row) => row.shopperId);
  const organizer = bundle.group.organizerShopperId;
  const send = (shopperIds: string[], message: string) =>
    notify(tx, {
      sessionId: bundle.group.sessionId,
      shopperIds,
      groupId: bundle.group.id,
      kind: `group_${to}`,
      message,
    });
  switch (to) {
    case "funding": {
      const opening =
        from === "open"
          ? `Your ${product} group is full!`
          : from === "replacement_needed"
            ? `The open share in the ${product} group is filled.`
            : `Everyone confirmed the ${product} group.`;
      for (const member of currentMembers(bundle.allocations)) {
        const share = formatCents(member.contributionCents);
        const contribution = operationById(bundle, member.contributionOperationId);
        const alreadySent = contribution !== null && contribution.status !== "failed";
        await send(
          [member.shopperId],
          alreadySent
            ? `${opening} Your ${share} share is already in; nothing to do.`
            : member.autoPay
              ? `${opening} Your ${share} share is being sent automatically.`
              : `${opening} Contribute your ${share} share to keep things moving.`,
        );
      }
      return;
    }
    case "awaiting_confirmation":
      if (from === "open") {
        return send(members, `Your ${product} group is full. Please confirm your final share.`);
      }
      return;
    case "replacement_needed":
      return send(
        members,
        `A share in the ${product} group opened up. We're finding a replacement; your price is unchanged.`,
      );
    case "ready_to_purchase":
      if (bundle.group.autoPurchase || !organizer) return;
      return send(
        [organizer],
        `Everyone has paid for the ${product} group. Record the purchase when you're ready.`,
      );
    case "purchased":
      return send(
        members,
        `The ${product} purchase is recorded. Pick up your share at the pickup point.`,
      );
    case "fulfilled":
      return send(members, `Everyone picked up their ${product}. Thanks for buying together!`);
    case "cancelling":
      return send(
        everyone,
        `The ${product} group is cancelling. Every contribution is being returned.`,
      );
    case "cancelled":
      return send(everyone, `The ${product} group was cancelled. Any contributions were returned.`);
    default:
      return;
  }
}

export async function bumpGroupVersion(tx: Tx, bundle: GroupBundle): Promise<void> {
  const [updated] = await tx
    .update(groups)
    .set({ version: sql`${groups.version} + 1`, updatedAt: runtime.now() })
    .where(eq(groups.id, bundle.group.id))
    .returning();
  if (updated) bundle.group = updated;
}

/** The frozen offer is still open and unchanged since the group snapshotted it. */
export function offerStillValid(bundle: GroupBundle): boolean {
  return (
    isOfferOpen(toOfferTerms(bundle.offer), runtime.now()) &&
    bundle.offer.version === bundle.group.offerSnapshot.version
  );
}

/**
 * Re-evaluate a group after any action or provider outcome: settle departures, create returns,
 * apply permitted status transitions, check readiness and dispatch prepared operations.
 */
export async function advanceGroup(providers: Providers, session: SessionRow, groupId: string) {
  const db = getDb();
  for (let iteration = 0; iteration < 8; iteration++) {
    const result = await db.transaction(async (tx) => {
      const group = await lockGroup(tx, session.id, groupId);
      let bundle = await loadBundleFor(tx, group);
      let changed = false;

      // Settle departing members.
      for (const allocation of bundle.allocations.filter((row) => row.state === "departing")) {
        const contribution = operationById(bundle, allocation.contributionOperationId);
        const returned = operationById(bundle, allocation.returnOperationId);
        const neverFunded = !contribution || contribution.status === "failed";
        if (neverFunded || returned?.status === "confirmed") {
          await tx
            .update(allocations)
            .set({ state: "departed", departedAt: runtime.now(), updatedAt: runtime.now() })
            .where(eq(allocations.id, allocation.id));
          changed = true;
        } else if (contribution.status === "confirmed" && !returned) {
          changed = (await prepareReturns(tx, bundle, new Set([allocation.id]))) || changed;
        }
      }

      if (bundle.group.status === "cancelling") {
        await abandonPreparedContributions(tx, bundle);
        changed = (await prepareReturns(tx, bundle)) || changed;
      }
      if (changed) bundle = await loadBundleFor(tx, bundle.group);

      const status = bundle.group.status;
      const departing = bundle.allocations.some((row) => row.state === "departing");
      const vacancies = vacantAllocations(bundle.allocations).length;
      const members = currentMembers(bundle.allocations);
      const allConsented = members.every((row) => row.consent !== null);
      let needsReadiness = false;
      let next: { status: GroupStatus; reason: string | null } | null = null;

      if ((status === "open" || status === "awaiting_confirmation") && !offerStillValid(bundle)) {
        const funded = bundle.operations.some(
          (row) => row.kind === "contribution" && row.status !== "failed",
        );
        next = { status: funded ? "cancelling" : "cancelled", reason: "offer_changed" };
        if (!funded) await releaseNeeds(tx, bundle.group.id, "forming");
      } else if (
        ["funding", "ready_to_purchase", "replacement_needed", "returning_contribution"].includes(
          status,
        ) &&
        !offerStillValid(bundle)
      ) {
        next = { status: "cancelling", reason: "offer_changed" };
      } else if (status === "funding" || status === "ready_to_purchase") {
        if (departing) next = { status: "returning_contribution", reason: null };
        else if (status === "funding") {
          const blockers = readinessBlockers({
            allocations: toFundingAllocations(bundle),
            totalCents: bundle.group.totalCents,
            collectionBalanceCents: null,
          });
          needsReadiness = blockers.length === 0;
        }
      } else if (status === "returning_contribution") {
        if (!departing) {
          next =
            vacancies > 0
              ? { status: "replacement_needed", reason: null }
              : { status: "funding", reason: null };
        }
      } else if (status === "replacement_needed") {
        if (departing) next = { status: "returning_contribution", reason: null };
        else if (vacancies === 0 && allConsented) next = { status: "funding", reason: null };
      } else if (status === "cancelling") {
        const settled = bundle.allocations.every((allocation) => {
          const contribution = operationById(bundle, allocation.contributionOperationId);
          if (!contribution || contribution.status === "failed") return true;
          if (contribution.status !== "confirmed") return false;
          return operationById(bundle, allocation.returnOperationId)?.status === "confirmed";
        });
        if (settled) {
          next = { status: "cancelled", reason: bundle.group.statusReason };
          await releaseNeeds(tx, bundle.group.id, "forming");
        }
      } else if (status === "purchasing") {
        const purchase = bundle.operations.find((row) => row.kind === "purchase");
        if (purchase?.status === "confirmed") next = { status: "purchased", reason: null };
        else if (purchase?.status === "failed") {
          next = { status: "ready_to_purchase", reason: "purchase_failed" };
        }
      } else if (status === "purchased") {
        if (members.length > 0 && members.every((row) => row.state === "picked_up")) {
          next = { status: "fulfilled", reason: null };
          await releaseNeeds(tx, bundle.group.id, "fulfilled");
        }
      }

      if (next && next.status !== status) {
        await setGroupStatus(tx, bundle, next.status, "system", next.reason);
        changed = true;
      } else if (changed) {
        await bumpGroupVersion(tx, bundle);
      }
      if (changed) {
        bundle = await loadBundleFor(tx, bundle.group);
      }
      const prepared = bundle.operations
        .filter((row) => row.status === "prepared")
        .map((row) => row.id);
      const finalStatus = bundle.group.status;
      // Members who pre-authorized payment and have nothing sent yet.
      const autoPay =
        finalStatus === "funding"
          ? currentMembers(bundle.allocations)
              .filter((row) => row.autoPay && row.consent && !row.contributionOperationId)
              .map((row) => row.id)
          : [];
      const purchaseOp = bundle.operations.find((row) => row.kind === "purchase");
      const autoPurchase =
        finalStatus === "ready_to_purchase" &&
        bundle.group.autoPurchase &&
        bundle.group.statusReason !== "purchase_failed" &&
        !purchaseOp;
      // Offer an open slot automatically however the group got here (funded or unfunded
      // dropout), unless an offer is already out or the last attempt found nobody.
      const [lastEvent] = await tx
        .select({ type: workflowEvents.type })
        .from(workflowEvents)
        .where(eq(workflowEvents.groupId, groupId))
        .orderBy(desc(workflowEvents.seq))
        .limit(1);
      const autoReplace =
        finalStatus === "replacement_needed" &&
        bundle.group.autoReplace &&
        vacantAllocations(bundle.allocations).length > 0 &&
        !hasPendingReplacement(bundle) &&
        lastEvent?.type !== "no_replacement_found";
      return { changed, prepared, needsReadiness, autoPay, autoPurchase, autoReplace };
    });

    let readinessChanged = false;
    if (result.needsReadiness) readinessChanged = await checkReadiness(providers, session, groupId);
    for (const operationId of result.prepared) await dispatchOperation(providers, operationId);
    let automated = false;
    for (const allocationId of result.autoPay) {
      automated = (await runAutoPay(providers, session, groupId, allocationId)) || automated;
    }
    if (result.autoReplace) {
      automated = (await runAutoReplace(providers, session, groupId)) || automated;
    }
    if (result.autoPurchase) {
      automated = (await runAutoPurchase(providers, session, groupId)) || automated;
    }
    if (result.prepared.length === 0 && !result.changed && !readinessChanged && !automated) return;
  }
}

/** Send a pre-authorized contribution. Failures turn auto-pay off and tell the member. */
async function runAutoPay(
  providers: Providers,
  session: SessionRow,
  groupId: string,
  allocationId: string,
): Promise<boolean> {
  try {
    await contributeAllocation(providers, session, allocationId, "auto-pay", { kind: "auto-pay" });
    return true;
  } catch (error) {
    log("warn", "automation.auto_pay_failed", {
      sessionId: session.id,
      groupId,
      error: String(error),
    });
    // Only a definite affordability problem turns auto-pay off. Transient provider errors and
    // state races leave the authorization in place; the next group update retries it.
    if (!(error instanceof DomainError && error.code === "INSUFFICIENT_FUNDS")) return false;
    await getDb().transaction(async (tx) => {
      const [allocation] = await tx
        .update(allocations)
        .set({ autoPay: false, updatedAt: runtime.now() })
        .where(eq(allocations.id, allocationId))
        .returning();
      if (!allocation) return;
      await notify(tx, {
        sessionId: session.id,
        shopperIds: [allocation.shopperId],
        groupId,
        kind: "auto_pay_paused",
        message: `Auto-pay paused: your ${formatCents(allocation.contributionCents)} share would leave too little for upcoming bills. You can contribute manually when ready.`,
      });
    });
    return true;
  }
}

/** Offer the vacated slot to the next compatible request right away. */
async function runAutoReplace(
  providers: Providers,
  session: SessionRow,
  groupId: string,
): Promise<boolean> {
  const { findReplacement } = await import("@/server/services/workflow-service");
  const [group] = await getDb().select().from(groups).where(eq(groups.id, groupId));
  if (group?.status !== "replacement_needed") return false;
  try {
    await findReplacement(
      providers,
      {
        session,
        shopperId: group.organizerShopperId ?? "",
        actor: "auto-replace",
        demoControl: true,
      },
      groupId,
      group.version,
    );
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "NO_REPLACEMENT") {
      await getDb().transaction(async (tx) => {
        await notify(tx, {
          sessionId: session.id,
          shopperIds: group.organizerShopperId ? [group.organizerShopperId] : [],
          groupId,
          kind: "no_replacement",
          message:
            group.origin === "organizer"
              ? "Nobody nearby matches the open share yet. Anyone with the invite link can take it, or you can cancel."
              : "Nobody nearby can take the open share yet. You can keep waiting or cancel the group.",
        });
      });
      return false;
    }
    log("warn", "automation.auto_replace_failed", {
      sessionId: session.id,
      groupId,
      error: String(error),
    });
    return false;
  }
}

/** Record the purchase the organizer pre-authorized once readiness has reconciled. */
async function runAutoPurchase(
  providers: Providers,
  session: SessionRow,
  groupId: string,
): Promise<boolean> {
  const { executePurchase } = await import("@/server/services/workflow-service");
  try {
    await executePurchase(providers, session, groupId, "auto-purchase", null);
    return true;
  } catch (error) {
    log("warn", "automation.auto_purchase_failed", {
      sessionId: session.id,
      groupId,
      error: String(error),
    });
    return false;
  }
}

/** Read the collection balance outside the transaction, then confirm readiness under the lock. */
async function checkReadiness(providers: Providers, session: SessionRow, groupId: string) {
  const db = getDb();
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group?.collectionAccountRef) return false;
  const balance = await effectiveBalanceCents(providers, session.id, group.collectionAccountRef);
  const confirmed = await getDb()
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.groupId, groupId));
  const records = await verifyProviderRecords(providers, confirmed);
  return db.transaction(async (tx) => {
    const locked = await lockGroup(tx, session.id, groupId);
    if (locked.status !== "funding") return false;
    const bundle = await loadBundleFor(tx, locked);
    const blockers = readinessBlockers({
      allocations: toFundingAllocations(bundle),
      totalCents: locked.totalCents,
      collectionBalanceCents: balance,
      providerRecordsVerified: records.ok,
    });
    if (blockers.length > 0) {
      await appendGroupEvent(tx, {
        sessionId: session.id,
        groupId,
        actor: "system",
        type: "readiness_blocked",
        payload: {
          blockers,
          collectionBalanceCents: balance,
          recordMismatches: records.mismatches,
        },
      });
      return false;
    }
    await setGroupStatus(tx, bundle, "ready_to_purchase", "system");
    return true;
  });
}

/**
 * Create (or return) the selected persona's contribution operation, then dispatch it. A retry is
 * allowed only after a definitive failure and only by explicit request.
 */
export async function contribute(
  providers: Providers,
  ctx: ActionContext,
  groupId: string,
  expectedVersion: number,
): Promise<OperationRow> {
  const [allocation] = await getDb()
    .select()
    .from(allocations)
    .where(
      and(
        eq(allocations.groupId, groupId),
        eq(allocations.sessionId, ctx.session.id),
        eq(allocations.shopperId, ctx.shopperId),
        eq(allocations.state, "active"),
      ),
    );
  if (!allocation) throw new DomainError("NOT_FOUND", "You are not part of this group.");
  return contributeAllocation(providers, ctx.session, allocation.id, ctx.actor, {
    kind: "explicit",
    expectedVersion,
  });
}

/**
 * How a contribution was requested. An explicit request carries the member's expected group
 * version and re-evaluates the group afterwards. Auto-pay acts on frozen terms the member already
 * consented to, from inside the group evaluation loop, so it neither checks a version nor advances.
 */
export type ContributionMode = { kind: "explicit"; expectedVersion: number } | { kind: "auto-pay" };

/** Shared path for explicit and pre-authorized (auto-pay) contributions. */
export async function contributeAllocation(
  providers: Providers,
  session: SessionRow,
  allocationId: string,
  actor: string,
  mode: ContributionMode,
): Promise<OperationRow> {
  const expectedVersion = mode.kind === "explicit" ? mode.expectedVersion : null;
  const db = getDb();
  const [allocation] = await db
    .select()
    .from(allocations)
    .where(and(eq(allocations.id, allocationId), eq(allocations.sessionId, session.id)));
  if (allocation?.state !== "active") {
    throw new DomainError("NOT_FOUND", "You are not part of this group.");
  }
  const groupId = allocation.groupId;

  if (allocation.contributionOperationId) {
    const [existing] = await db
      .select()
      .from(bankOperations)
      .where(eq(bankOperations.id, allocation.contributionOperationId));
    if (existing && existing.status !== "failed") return existing;
  }

  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group || group.sessionId !== session.id) {
    throw new DomainError("NOT_FOUND", "Group not found.");
  }
  if (group.status !== "funding") {
    throw new DomainError(
      "INCOMPATIBLE_STATE",
      "This group is not collecting contributions right now.",
    );
  }
  if (expectedVersion !== null) assertVersion(group, expectedVersion);
  const shopperRow = await getShopper(session.id, allocation.shopperId);
  if (!shopperRow.fundingAccountRef) {
    throw new DomainError("UPSTREAM_UNAVAILABLE", "No funding account.");
  }

  // Balance and bills are snapshots, not holds; they are checked again here before dispatch.
  const money = await spendable(providers, session, shopperRow, group.pickupWindow, {
    excludeAllocationId: allocation.id,
  });
  if (!money || money.spendableCents < allocation.contributionCents) {
    throw new DomainError(
      "INSUFFICIENT_FUNDS",
      "This contribution would leave too little for your upcoming bills, so it was not sent.",
    );
  }
  const collectionAccountRef = await ensureCollectionAccount(providers, session, groupId);

  const operation = await db.transaction(async (tx) => {
    const locked = await lockGroup(tx, session.id, groupId);
    if (expectedVersion !== null) assertVersion(locked, expectedVersion);
    if (locked.status !== "funding") {
      throw new DomainError(
        "INCOMPATIBLE_STATE",
        "This group is not collecting contributions right now.",
      );
    }
    const [current] = await tx.select().from(allocations).where(eq(allocations.id, allocation.id));
    if (current?.state !== "active" || !current.consent) {
      throw new DomainError("INCOMPATIBLE_STATE", "Confirm your terms before contributing.");
    }
    if (current.contributionOperationId) {
      const [existing] = await tx
        .select()
        .from(bankOperations)
        .where(eq(bankOperations.id, current.contributionOperationId))
        .for("update");
      if (existing && existing.status !== "failed") return existing;
      if (existing) {
        // Explicit retry of a definitively rejected, never-executed contribution.
        const [retried] = await tx
          .update(bankOperations)
          .set({
            status: "prepared",
            revision: sql`${bankOperations.revision} + 1`,
            updatedAt: runtime.now(),
          })
          .where(and(eq(bankOperations.id, existing.id), eq(bankOperations.status, "failed")))
          .returning();
        if (!retried) throw new DomainError("INCOMPATIBLE_STATE", "Operation changed; try again.");
        await appendGroupEvent(tx, {
          sessionId: session.id,
          groupId,
          actor,
          type: "contribution_retry_requested",
          payload: { operationId: retried.id },
        });
        return retried;
      }
    }
    const created = await prepareOperation(tx, {
      sessionId: session.id,
      groupId,
      allocationId: current.id,
      kind: "contribution",
      operationKey: `contribution:${current.id}`,
      amountCents: current.contributionCents,
      fromAccountRef: shopperRow.fundingAccountRef ?? "",
      toRef: collectionAccountRef,
    });
    await tx
      .update(allocations)
      .set({ contributionOperationId: created.id, updatedAt: runtime.now() })
      .where(eq(allocations.id, current.id));
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId,
      actor,
      type: "contribution_requested",
      payload: {
        operationId: created.id,
        amountCents: created.amountCents,
        autoPay: expectedVersion === null,
      },
    });
    return created;
  });

  if (operation.status === "prepared") await dispatchOperation(providers, operation.id);
  if (mode.kind === "explicit") await advanceGroup(providers, session, groupId);
  return reloadOperation(operation.id);
}

/** Operator-only explicit retry of a definitively failed return or purchase. */
export async function retryFailedOperation(
  providers: Providers,
  session: SessionRow,
  operationId: string,
): Promise<OperationRow> {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(bankOperations)
    .where(and(eq(bankOperations.id, operationId), eq(bankOperations.sessionId, session.id)));
  if (!operation) throw new DomainError("NOT_FOUND", "Operation not found.");
  const groupId = operation.groupId;
  if (
    operation.status !== "failed" ||
    !groupId ||
    (operation.kind !== "return" && operation.kind !== "purchase")
  ) {
    throw new DomainError(
      "INCOMPATIBLE_STATE",
      "Only a definitively failed return or purchase can be retried here.",
    );
  }
  if (operation.lastError?.code === "CANCELLED_BEFORE_DISPATCH") {
    throw new DomainError("INCOMPATIBLE_STATE", "This operation was intentionally abandoned.");
  }
  await db.transaction(async (tx) => {
    const group = await lockGroup(tx, session.id, groupId);
    if (operation.kind === "purchase" && group.status !== "ready_to_purchase") {
      throw new DomainError(
        "INCOMPATIBLE_STATE",
        "Purchase retries start from the purchase button.",
      );
    }
    const [updated] = await tx
      .update(bankOperations)
      .set({
        status: "prepared",
        revision: sql`${bankOperations.revision} + 1`,
        updatedAt: runtime.now(),
      })
      .where(and(eq(bankOperations.id, operationId), eq(bankOperations.status, "failed")))
      .returning();
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId: groupId,
      actor: "operator",
      type: "operation_retry_requested",
      payload: { operationId },
    });
  });
  await dispatchOperation(providers, operationId);
  await advanceGroup(providers, session, groupId);
  return reloadOperation(operationId);
}
