import { z } from "zod";
import { MAX_NEED_TEXT } from "@/domain/need-parse";
import { json, personaContext, readJson, route } from "@/server/http";
import { parseNeedText } from "@/server/services/need-parse-service";

const body = z.object({ text: z.string().max(MAX_NEED_TEXT) });

/** Suggests form values from plain English. Never creates a need. */
export async function POST(request: Request) {
  return route(request, async () => {
    const { session, providers } = await personaContext();
    const input = await readJson(request, body);
    return json(await parseNeedText(providers, session, input.text));
  });
}
