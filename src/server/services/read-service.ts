import { desc, eq } from "drizzle-orm";
import type { GroupView, OperatorView } from "@/lib/view-types";
import { getDb } from "@/server/db/client";
import { groups, shoppers, workflowEvents } from "@/server/db/schema";
import type { Providers } from "@/server/providers";
import { buildGroupView, loadBundleFor, loadGroupBundle } from "@/server/services/group-view";
import { getSessionView, type SessionRow } from "@/server/services/session-service";
import { outboxStatus } from "@/server/services/sync-service";

async function collectionBalance(providers: Providers, ref: string | null): Promise<number | null> {
  if (!ref) return null;
  try {
    return await providers.banking.getBalanceCents(ref);
  } catch {
    return null;
  }
}

/** Read-only group view. Never dispatches or reconciles anything. */
export async function getGroupView(
  providers: Providers,
  session: SessionRow,
  groupId: string,
  viewerShopperId: string | null,
): Promise<GroupView> {
  const bundle = await loadGroupBundle(getDb(), session.id, groupId);
  const balance = await collectionBalance(providers, bundle.group.collectionAccountRef);
  const view = buildGroupView(session, bundle, viewerShopperId, balance);
  if (view.explanation && view.explanation.proposalVersion !== bundle.group.version) {
    view.explanation.stale = true;
  }
  return view;
}

export async function listGroupsForShopper(
  session: SessionRow,
  shopperId: string,
): Promise<GroupView[]> {
  const db = getDb();
  const rows = await db
    .select({ group: groups })
    .from(groups)
    .where(eq(groups.sessionId, session.id))
    .orderBy(desc(groups.createdAt));
  const views: GroupView[] = [];
  for (const { group } of rows) {
    const bundle = await loadBundleFor(db, group);
    if (!bundle.allocations.some((row) => row.shopperId === shopperId)) continue;
    if (group.status === "cancelled" && group.statusReason === "superseded") continue;
    views.push(buildGroupView(session, bundle, shopperId, null));
  }
  return views;
}

export async function getOperatorView(
  providers: Providers,
  session: SessionRow,
): Promise<OperatorView> {
  const db = getDb();
  const groupRows = await db
    .select()
    .from(groups)
    .where(eq(groups.sessionId, session.id))
    .orderBy(desc(groups.updatedAt))
    .limit(20);
  const groupViews: GroupView[] = [];
  for (const group of groupRows) {
    if (group.statusReason === "superseded") continue;
    const bundle = await loadBundleFor(db, group);
    groupViews.push(
      buildGroupView(
        session,
        bundle,
        session.selectedShopperId,
        await collectionBalance(providers, group.collectionAccountRef),
      ),
    );
  }

  const events = await db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.sessionId, session.id))
    .orderBy(desc(workflowEvents.id))
    .limit(40);
  const shopperRows = await db.select().from(shoppers).where(eq(shoppers.sessionId, session.id));
  const balances = [];
  for (const shopper of shopperRows) {
    balances.push({
      shopperId: shopper.id,
      name: shopper.displayName,
      balanceCents: await collectionBalance(providers, shopper.fundingAccountRef),
    });
  }
  return {
    session: await getSessionView(session),
    groups: groupViews,
    events: events.map((event) => ({
      id: event.id,
      groupId: event.groupId,
      seq: event.seq,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    })),
    outbox: await outboxStatus(session.id),
    balances,
  };
}
