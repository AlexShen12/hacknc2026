import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { getInsights } from "@/server/services/insights-service";
import { requireReady } from "@/server/services/session-service";

/** Synchronizes the analytical copies (idempotent), then queries them. Never moves money. */
export async function GET(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    requireReady(session);
    return json(await getInsights(providersFor(session.mode), session));
  });
}
