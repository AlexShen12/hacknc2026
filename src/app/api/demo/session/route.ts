import { currentSession, json, route } from "@/server/http";
import { getSessionView } from "@/server/services/session-service";

export async function GET(request: Request) {
  return route(request, async () => json(await getSessionView(await currentSession())));
}
