import { currentSession, json, route } from "@/server/http";
import { markNotificationsRead } from "@/server/services/notification-service";

export async function POST(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    if (session.selectedShopperId)
      await markNotificationsRead(session.id, session.selectedShopperId);
    return json({ ok: true });
  });
}
