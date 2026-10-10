import { currentSession, json, readJson, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { demoActionSchema, runDemoAction } from "@/server/services/demo-service";
import { requireReady } from "@/server/services/session-service";

export async function POST(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    requireReady(session);
    const input = await readJson(request, demoActionSchema);
    return json(await runDemoAction(providersFor(session.mode), session, input));
  });
}
