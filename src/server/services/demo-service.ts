import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { quoteShareCents } from "@/domain/open-group";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { demoSessions, groups, needs, offers } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import {
  type ActionContext,
  advanceGroup,
  contribute,
  reconcileOperation,
  retryFailedOperation,
} from "@/server/services/funding-service";
import { joinGroup } from "@/server/services/group-builder-service";
import { currentMembers, joinSlotFor, loadGroupBundle } from "@/server/services/group-view";
import { appendSessionEvent } from "@/server/services/records";
import { getShopper, type SessionRow } from "@/server/services/session-service";
import {
  cancelGroup,
  confirmPickup,
  confirmTerms,
  findReplacement,
  purchase,
  withdraw,
} from "@/server/services/workflow-service";

const personaAction = z.object({
  action: z.enum(["confirm", "contribute", "withdraw", "pickup", "replace", "cancel", "purchase"]),
  actorShopperId: z.string().min(1),
  groupId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
});

export const demoActionSchema = z.discriminatedUnion("action", [
  personaAction.extend({ action: z.literal("confirm") }),
  personaAction.extend({ action: z.literal("contribute") }),
  personaAction.extend({ action: z.literal("withdraw") }),
  personaAction.extend({ action: z.literal("pickup") }),
  personaAction.extend({ action: z.literal("replace") }),
  personaAction.extend({ action: z.literal("cancel") }),
  personaAction.extend({ action: z.literal("purchase") }),
  personaAction.extend({ action: z.literal("join") }),
  z.object({ action: z.literal("reconcile"), operationId: z.string().min(1) }),
  z.object({ action: z.literal("retry_operation"), operationId: z.string().min(1) }),
  z.object({
    action: z.literal("set_fault"),
    fault: z.enum(["pending", "unknown", "reject"]).nullable(),
  }),
  z.object({ action: z.literal("expire_offer"), groupId: z.string().min(1) }),
]);

export type DemoAction = z.infer<typeof demoActionSchema>;

/**
 * Allowlisted scenario controls. Persona actions run the same services as consumer actions, for a
 * seeded shopper of this session only; nothing here accepts account IDs or provider methods.
 */
export async function runDemoAction(providers: Providers, session: SessionRow, input: DemoAction) {
  if (!getConfig().DEMO_CONTROLS_ENABLED) {
    throw new DomainError("DEMO_CONTROLS_DISABLED", "Demo controls are disabled.");
  }
  switch (input.action) {
    case "confirm":
    case "contribute":
    case "withdraw":
    case "pickup":
    case "replace":
    case "cancel":
    case "purchase": {
      await getShopper(session.id, input.actorShopperId);
      const ctx: ActionContext = {
        session,
        shopperId: input.actorShopperId,
        actor: `demo:${input.actorShopperId}`,
        demoControl: input.action === "cancel" || input.action === "replace",
      };
      const run = {
        confirm: () => confirmTerms(providers, ctx, input.groupId, input.expectedVersion),
        contribute: () => contribute(providers, ctx, input.groupId, input.expectedVersion),
        withdraw: () => withdraw(providers, ctx, input.groupId, input.expectedVersion),
        pickup: () => confirmPickup(providers, ctx, input.groupId, input.expectedVersion),
        replace: () => findReplacement(providers, ctx, input.groupId, input.expectedVersion),
        cancel: () =>
          cancelGroup(
            providers,
            ctx,
            input.groupId,
            input.expectedVersion,
            "cancelled_by_operator",
          ),
        purchase: () => purchase(providers, ctx, input.groupId, input.expectedVersion),
      }[input.action];
      await run();
      return { ok: true };
    }
    case "join": {
      await getShopper(session.id, input.actorShopperId);
      const ctx: ActionContext = {
        session,
        shopperId: input.actorShopperId,
        actor: `demo:${input.actorShopperId}`,
        demoControl: true,
      };
      await joinGroup(providers, ctx, input.groupId, input.expectedVersion, {
        ...(await demoJoinTerms(session, input.actorShopperId, input.groupId)),
        autoPay: true,
      });
      return { ok: true };
    }
    case "reconcile":
      return { operation: await reconcileOperation(providers, session, input.operationId) };
    case "retry_operation":
      return { operation: await retryFailedOperation(providers, session, input.operationId) };
    case "set_fault": {
      if (session.mode !== "rehearsal") {
        throw new DomainError(
          "INCOMPATIBLE_STATE",
          "Fault injection exists only in rehearsal mode.",
        );
      }
      await getDb()
        .update(demoSessions)
        .set({ rehearsalFault: input.fault })
        .where(eq(demoSessions.id, session.id));
      await appendSessionEvent(getDb(), {
        sessionId: session.id,
        actor: "operator",
        type: "rehearsal_fault_set",
        payload: { fault: input.fault },
      });
      return { fault: input.fault };
    }
    case "expire_offer": {
      const db = getDb();
      const [group] = await db
        .select()
        .from(groups)
        .where(and(eq(groups.id, input.groupId), eq(groups.sessionId, session.id)));
      if (!group) throw new DomainError("NOT_FOUND", "Group not found.");
      await db.transaction(async (tx) => {
        const [offer] = await tx
          .update(offers)
          .set({ expiresAt: runtime.now(), version: sql`${offers.version} + 1` })
          .where(and(eq(offers.id, group.offerId), eq(offers.sessionId, session.id)))
          .returning();
        await appendSessionEvent(tx, {
          sessionId: session.id,
          actor: "operator",
          type: "offer_expired",
          payload: { offerId: group.offerId },
        });
      });
      await advanceGroup(providers, session, group.id);
      return { ok: true };
    }
  }
}

/**
 * Terms a seeded persona would join with: its own open request for this product when that fits,
 * otherwise the smallest comparable quantity still available, priced at the quoted share.
 */
async function demoJoinTerms(session: SessionRow, shopperId: string, groupId: string) {
  const db = getDb();
  const bundle = await loadGroupBundle(db, session.id, groupId);
  const slot = joinSlotFor(bundle);
  if (!slot) throw new DomainError("INCOMPATIBLE_STATE", "This group isn't taking new members.");
  const [need] = await db
    .select()
    .from(needs)
    .where(
      and(
        eq(needs.sessionId, session.id),
        eq(needs.shopperId, shopperId),
        eq(needs.status, "forming"),
        sql`${needs.acceptedOfferIds} @> ${JSON.stringify([bundle.offer.id])}::jsonb`,
      ),
    );
  if (slot.mode === "slot") {
    return {
      quantity: slot.quantity,
      maxContributionCents: Math.max(need?.maxContributionCents ?? 0, slot.contributionCents),
    };
  }
  const remaining =
    bundle.offer.packageQuantity -
    currentMembers(bundle.allocations).reduce((sum, row) => sum + row.quantity, 0);
  const quantity =
    need && need.quantity <= remaining
      ? need.quantity
      : (bundle.offer.baselines
          .map((row) => row.quantity)
          .filter((value) => value <= remaining)
          .sort((a, b) => a - b)[0] ?? remaining);
  const quote = quoteShareCents(bundle.offer.totalCents, quantity, bundle.offer.packageQuantity);
  return { quantity, maxContributionCents: need?.maxContributionCents ?? quote };
}
