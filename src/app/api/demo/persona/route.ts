import { z } from "zod";
import { currentSession, json, readJson, route } from "@/server/http";
import { getSessionView, selectPersona } from "@/server/services/session-service";

const body = z.object({ shopperId: z.string().min(1) });

export async function POST(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    const input = await readJson(request, body);
    await selectPersona(session, input.shopperId);
    return json(await getSessionView({ ...session, selectedShopperId: input.shopperId }));
  });
}
