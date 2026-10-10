import { and, eq, isNull, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { readinessBlockers } from "@/domain/funding";
import { isOfferOpen } from "@/domain/matching";
import type { GroupStatus, OperationKind, OperationStatus } from "@/domain/types";
import { getDb, type Tx } from "@/server/db/client";
import { allocations, bankOperations, groups, needs, operationAttempts } from "@/server/db/schema";
import { log } from "@/server/observability/logger";
import type { Providers } from "@/server/providers";
import {
  type ObservedOutcome,
  operationDescription,
  type SubmitOutcome,
} from "@/server/providers/banking/types";
import { runtime } from "@/server/runtime";
import {
  currentMembers,
  type GroupBundle,
  loadBundleFor,
  operationById,
  toFundingAllocations,
  vacantAllocations,
} from "@/server/services/group-view";
import {
  appendGroupEvent,
  assertVersion,
  enqueueGroup,
  enqueueNeed,
  enqueueOperation,
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
    groupId: string;
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
    await enqueueOperation(tx, created);
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
    await enqueueOperation(tx, operation);
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
    outcome =
      claimed.kind === "purchase"
        ? await providers.banking.submitPurchase({
            sessionId: claimed.sessionId,
            correlation: description,
            fromAccountRef: claimed.fromAccountRef,
            merchantRef: claimed.toRef,
            amountCents: claimed.amountCents,
            description,
          })
        : await providers.banking.submitTransfer({
            sessionId: claimed.sessionId,
            correlation: description,
            fromAccountRef: claimed.fromAccountRef,
            toAccountRef: claimed.toRef,
            amountCents: claimed.amountCents,
            description,
          });
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
    await lockGroup(tx, claimed.sessionId, claimed.groupId);
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
    await enqueueOperation(tx, recorded);
    await appendGroupEvent(tx, {
      sessionId: recorded.sessionId,
      groupId: recorded.groupId,
      actor: "system",
      type: `${recorded.kind}_${status}`,
      payload: {
        operationId: recorded.id,
        amountCents: recorded.amountCents,
        providerId: recorded.providerId,
        error: error?.code,
      },
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

  if (operation.status === "prepared") {
    // Never sent, so dispatching is the first attempt rather than a retry.
    await dispatchOperation(providers, operation.id);
    await advanceGroup(providers, session, operation.groupId);
    return reloadOperation(operation.id);
  }
  const staleDispatch =
    operation.status === "dispatching" &&
    runtime.now().getTime() - operation.updatedAt.getTime() > STALE_DISPATCH_MS;
  if (operation.status !== "pending" && operation.status !== "unknown" && !staleDispatch) {
    await advanceGroup(providers, session, operation.groupId);
    return reloadOperation(operation.id);
  }

  const kind = operation.kind === "purchase" ? "purchase" : "transfer";
  let observed: ObservedOutcome;
  let method: "provider_id" | "correlation" | "none";
  if (operation.providerId) {
    method = "provider_id";
    observed = await providers.banking.observe(kind, operation.providerId);
  } else if (providers.banking.capabilities.correlationLookup) {
    method = "correlation";
    observed = await providers.banking.findByCorrelation({
      kind,
      fromAccountRef: operation.fromAccountRef,
      correlation: operationDescription(operation.operationKey),
    });
  } else {
    method = "none";
    observed = { found: false };
  }

  await db.transaction(async (tx) => {
    await lockGroup(tx, session.id, operation.groupId);
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
    } else if (method === "correlation") {
      // A verified correlation lookup that finds nothing proves the write never executed.
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
      if (updated) await enqueueOperation(tx, updated);
    }
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId: operation.groupId,
      actor: "system",
      type: status ? "operation_reconciled" : "reconciliation_needs_operator",
      payload: { operationId: operation.id, method, status: status ?? operation.status },
    });
  });
  await advanceGroup(providers, session, operation.groupId);
  return reloadOperation(operation.id);
}

async function reloadOperation(operationId: string): Promise<OperationRow> {
  const [row] = await getDb()
    .select()
    .from(bankOperations)
    .where(eq(bankOperations.id, operationId));
  if (!row) throw new DomainError("NOT_FOUND", "Operation not found.");
  return row;
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

async function releaseNeeds(tx: Tx, groupId: string, status: "forming" | "fulfilled") {
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
  for (const need of released) await enqueueNeed(tx, need);
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
    if (updated) await enqueueOperation(tx, updated);
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
}

export async function bumpGroupVersion(tx: Tx, bundle: GroupBundle): Promise<void> {
  const [updated] = await tx
    .update(groups)
    .set({ version: sql`${groups.version} + 1`, updatedAt: runtime.now() })
    .where(eq(groups.id, bundle.group.id))
    .returning();
  if (updated) bundle.group = updated;
}

function offerStillValid(bundle: GroupBundle): boolean {
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

      if (
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
        await enqueueGroup(tx, bundle.group, bundle.allocations);
      }
      const prepared = bundle.operations
        .filter((row) => row.status === "prepared")
        .map((row) => row.id);
      return { changed, prepared, needsReadiness };
    });

    let readinessChanged = false;
    if (result.needsReadiness) readinessChanged = await checkReadiness(providers, session, groupId);
    for (const operationId of result.prepared) await dispatchOperation(providers, operationId);
    if (result.prepared.length === 0 && !result.changed && !readinessChanged) return;
  }
}

/** Read the collection balance outside the transaction, then confirm readiness under the lock. */
async function checkReadiness(providers: Providers, session: SessionRow, groupId: string) {
  const db = getDb();
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group?.collectionAccountRef) return false;
  const balance = await providers.banking.getBalanceCents(group.collectionAccountRef);
  return db.transaction(async (tx) => {
    const locked = await lockGroup(tx, session.id, groupId);
    if (locked.status !== "funding") return false;
    const bundle = await loadBundleFor(tx, locked);
    const blockers = readinessBlockers({
      allocations: toFundingAllocations(bundle),
      totalCents: locked.totalCents,
      collectionBalanceCents: balance,
    });
    if (blockers.length > 0) {
      await appendGroupEvent(tx, {
        sessionId: session.id,
        groupId,
        actor: "system",
        type: "readiness_blocked",
        payload: { blockers, collectionBalanceCents: balance },
      });
      return false;
    }
    await setGroupStatus(tx, bundle, "ready_to_purchase", "system");
    await enqueueGroup(tx, bundle.group, bundle.allocations);
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
  const db = getDb();
  const { session, shopperId } = ctx;
  const [allocation] = await db
    .select()
    .from(allocations)
    .where(
      and(
        eq(allocations.groupId, groupId),
        eq(allocations.sessionId, session.id),
        eq(allocations.shopperId, shopperId),
        eq(allocations.state, "active"),
      ),
    );
  if (!allocation) throw new DomainError("NOT_FOUND", "You are not part of this group.");

  if (allocation.contributionOperationId) {
    const [existing] = await db
      .select()
      .from(bankOperations)
      .where(eq(bankOperations.id, allocation.contributionOperationId));
    if (existing && existing.status !== "failed") return existing;
  }

  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group || group.sessionId !== session.id)
    throw new DomainError("NOT_FOUND", "Group not found.");
  if (group.status !== "funding") {
    throw new DomainError(
      "INCOMPATIBLE_STATE",
      "This group is not collecting contributions right now.",
    );
  }
  assertVersion(group, expectedVersion);
  const shopperRow = await getShopper(session.id, shopperId);
  if (!shopperRow.fundingAccountRef)
    throw new DomainError("UPSTREAM_UNAVAILABLE", "No funding account.");

  // Balance snapshot is not a hold; it is checked again here before dispatch.
  const balance = await providers.banking.getBalanceCents(shopperRow.fundingAccountRef);
  if (balance - shopperRow.bufferCents < allocation.contributionCents) {
    throw new DomainError(
      "INSUFFICIENT_FUNDS",
      "This contribution would dip into your bill buffer, so it was not sent.",
    );
  }
  const collectionAccountRef = await ensureCollectionAccount(providers, session, groupId);

  const operation = await db.transaction(async (tx) => {
    const locked = await lockGroup(tx, session.id, groupId);
    assertVersion(locked, expectedVersion);
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
        await enqueueOperation(tx, retried);
        await appendGroupEvent(tx, {
          sessionId: session.id,
          groupId,
          actor: ctx.actor,
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
      actor: ctx.actor,
      type: "contribution_requested",
      payload: { operationId: created.id, amountCents: created.amountCents },
    });
    return created;
  });

  if (operation.status === "prepared") await dispatchOperation(providers, operation.id);
  await advanceGroup(providers, session, groupId);
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
  if (operation.status !== "failed" || operation.kind === "contribution") {
    throw new DomainError(
      "INCOMPATIBLE_STATE",
      "Only a definitively failed return or purchase can be retried here.",
    );
  }
  if (operation.lastError?.code === "CANCELLED_BEFORE_DISPATCH") {
    throw new DomainError("INCOMPATIBLE_STATE", "This operation was intentionally abandoned.");
  }
  await db.transaction(async (tx) => {
    const group = await lockGroup(tx, session.id, operation.groupId);
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
    if (updated) await enqueueOperation(tx, updated);
    await appendGroupEvent(tx, {
      sessionId: session.id,
      groupId: operation.groupId,
      actor: "operator",
      type: "operation_retry_requested",
      payload: { operationId },
    });
  });
  await dispatchOperation(providers, operationId);
  await advanceGroup(providers, session, operation.groupId);
  return reloadOperation(operationId);
}
