import { z } from "zod";
import { json, personaContext, readJson, route } from "@/server/http";
import { runMatching } from "@/server/services/matching-service";

const body = z.object({ needId: z.string().min(1) });

export async function POST(request: Request) {
  return route(request, async () => {
    const { providers, ctx } = await personaContext();
    const input = await readJson(request, body);
    return json(await runMatching(providers, ctx, input.needId));
  });
}
