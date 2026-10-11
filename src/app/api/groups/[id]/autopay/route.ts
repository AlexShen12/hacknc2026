import { z } from "zod";
import { json, personaContext, readJson, route } from "@/server/http";
import { setAutoPay } from "@/server/services/group-builder-service";
import { getGroupView } from "@/server/services/read-service";

const body = z.object({ expectedVersion: z.number().int().positive(), enabled: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const input = await readJson(request, body);
    await setAutoPay(providers, ctx, id, input.expectedVersion, input.enabled);
    return json(await getGroupView(providers, session, id, ctx.shopperId));
  });
}
