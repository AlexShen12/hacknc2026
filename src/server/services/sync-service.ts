import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { syncOutbox } from "@/server/db/schema";
import { log } from "@/server/observability/logger";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";

const BATCH_LIMIT = 200;

/**
 * Bounded, awaited synchronization of the session's outbox to the analytics provider. Only the
 * latest pending version per entity is sent; superseded versions are marked delivered. Failures
 * stay pending and are rethrown so sponsor-mode matching returns a retryable error.
 */
export async function syncSession(
  sessionId: string,
  providers: Providers,
): Promise<{ deliveredThroughId: number | null; delivered: number }> {
  const db = getDb();
  const pending = await db
    .select()
    .from(syncOutbox)
    .where(
      and(eq(syncOutbox.sessionId, sessionId), inArray(syncOutbox.status, ["pending", "failed"])),
    )
    .orderBy(asc(syncOutbox.id))
    .limit(BATCH_LIMIT);

  if (pending.length === 0) {
    const [row] = await db
      .select({ id: max(syncOutbox.id) })
      .from(syncOutbox)
      .where(eq(syncOutbox.sessionId, sessionId));
    return { deliveredThroughId: row?.id ?? null, delivered: 0 };
  }

  const latest = new Map<string, (typeof pending)[number]>();
  for (const record of pending) {
    const key = `${record.entityType}:${record.entityId}`;
    const current = latest.get(key);
    if (!current || record.entityVersion >= current.entityVersion) latest.set(key, record);
  }
  const toSend = [...latest.values()];
  const superseded = pending
    .filter((record) => !toSend.includes(record))
    .map((record) => record.id);

  const started = Date.now();
  try {
    await providers.analytics.sync(toSend);
  } catch (error) {
    await db
      .update(syncOutbox)
      .set({
        status: "failed",
        attempts: sql`${syncOutbox.attempts} + 1`,
        lastError: String(error).slice(0, 500),
      })
      .where(
        inArray(
          syncOutbox.id,
          toSend.map((record) => record.id),
        ),
      );
    log("warn", "sync.failed", { sessionId, records: toSend.length, error: String(error) });
    throw error;
  }

  const ids = [...toSend.map((record) => record.id), ...superseded];
  await db
    .update(syncOutbox)
    .set({
      status: "delivered",
      deliveredAt: runtime.now(),
      attempts: sql`${syncOutbox.attempts} + 1`,
    })
    .where(inArray(syncOutbox.id, ids));
  log("info", "sync.delivered", {
    sessionId,
    provider: providers.analytics.name,
    records: toSend.length,
    durationMs: Date.now() - started,
  });
  return { deliveredThroughId: Math.max(...ids), delivered: toSend.length };
}

export async function outboxStatus(sessionId: string) {
  const db = getDb();
  const rows = await db
    .select({ status: syncOutbox.status, count: sql<number>`count(*)::int` })
    .from(syncOutbox)
    .where(eq(syncOutbox.sessionId, sessionId))
    .groupBy(syncOutbox.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<
    Record<"pending" | "delivered" | "failed", number>
  >;
}
