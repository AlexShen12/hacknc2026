import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { demoSessions, groups, offers } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import {
  type ActionContext,
  advanceGroup,
  contribute,
  reconcileOperation,
  retryFailedOperation,
} from "@/server/services/funding-service";
import { appendSessionEvent, enqueueOffer } from "@/server/services/records";
import { getShopper, type SessionRow } from "@/server/services/session-service";
import { syncSession } from "@/server/services/sync-service";
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
  z.object({ action: z.literal("reconcile"), operationId: z.string().min(1) }),
  z.object({ action: z.literal("retry_operation"), operationId: z.string().min(1) }),
  z.object({
    action: z.literal("set_fault"),
    fault: z.enum(["pending", "unknown", "reject"]).nullable(),
  }),
  z.object({ action: z.literal("expire_offer"), groupId: z.string().min(1) }),
  z.object({ action: z.literal("sync") }),
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
        if (offer) await enqueueOffer(tx, offer);
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
    case "sync":
      return syncSession(session.id, providers);
  }
}
