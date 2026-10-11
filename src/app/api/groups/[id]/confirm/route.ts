import { z } from "zod";
import { json, personaContext, readJson, route } from "@/server/http";
import { getGroupView } from "@/server/services/read-service";
import { confirmTerms } from "@/server/services/workflow-service";

const body = z.object({
  expectedVersion: z.number().int().positive(),
  autoPay: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const { expectedVersion, autoPay } = await readJson(request, body);
    await confirmTerms(providers, ctx, id, expectedVersion, { autoPay });
    return json(await getGroupView(providers, session, id, ctx.shopperId));
  });
}
