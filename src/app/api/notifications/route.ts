import { currentSession, json, route } from "@/server/http";
import { listNotifications } from "@/server/services/notification-service";

export async function GET(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    if (!session.selectedShopperId) return json({ unread: 0, items: [] });
    return json(await listNotifications(session.id, session.selectedShopperId));
  });
}
