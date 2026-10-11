import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "@/server/db/client";
import { getDb } from "@/server/db/client";
import { notifications } from "@/server/db/schema";
import { runtime } from "@/server/runtime";

export interface NotificationView {
  id: string;
  groupId: string | null;
  kind: string;
  message: string;
  createdAt: string;
  read: boolean;
}

/** Write feed entries for each recipient. Call inside the transaction that made the change. */
export async function notify(
  tx: DbOrTx,
  input: {
    sessionId: string;
    shopperIds: Iterable<string>;
    groupId: string | null;
    kind: string;
    message: string;
  },
): Promise<void> {
  const recipients = [...new Set(input.shopperIds)];
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(
    recipients.map((shopperId) => ({
      id: runtime.newId("ntf"),
      sessionId: input.sessionId,
      shopperId,
      groupId: input.groupId,
      kind: input.kind,
      message: input.message,
      createdAt: runtime.now(),
    })),
  );
}

export async function listNotifications(
  sessionId: string,
  shopperId: string,
): Promise<{ unread: number; items: NotificationView[] }> {
  const rows = await getDb()
    .select()
    .from(notifications)
    .where(and(eq(notifications.sessionId, sessionId), eq(notifications.shopperId, shopperId)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(30);
  return {
    unread: rows.filter((row) => row.readAt === null).length,
    items: rows.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      kind: row.kind,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      read: row.readAt !== null,
    })),
  };
}

export async function markNotificationsRead(sessionId: string, shopperId: string): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ readAt: runtime.now() })
    .where(
      and(
        eq(notifications.sessionId, sessionId),
        eq(notifications.shopperId, shopperId),
        isNull(notifications.readAt),
      ),
    );
}
