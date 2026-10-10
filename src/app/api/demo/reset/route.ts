import { currentSession, json, route, setSessionCookie } from "@/server/http";
import { getSessionView, resetSession } from "@/server/services/session-service";

export async function POST(request: Request) {
  return route(request, async () => {
    const { session, token } = await resetSession(await currentSession());
    await setSessionCookie(request, token);
    return json(await getSessionView(session), 201);
  });
}
