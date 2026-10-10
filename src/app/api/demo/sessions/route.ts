import { z } from "zod";
import { PROVIDER_MODES } from "@/domain/types";
import { getConfig } from "@/server/config";
import { json, readJson, route, setSessionCookie } from "@/server/http";
import { createSession, getSessionView } from "@/server/services/session-service";

const body = z.object({ mode: z.enum(PROVIDER_MODES).optional() });

export async function POST(request: Request) {
  return route(request, async () => {
    const input = await readJson(request, body);
    const { session, token } = await createSession({
      mode: input.mode ?? getConfig().PROVIDER_MODE,
    });
    await setSessionCookie(request, token);
    return json(await getSessionView(session), 201);
  });
}
