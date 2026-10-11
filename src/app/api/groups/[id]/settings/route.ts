import { z } from "zod";
import { json, personaContext, readJson, route } from "@/server/http";
import { updateGroupSettings } from "@/server/services/group-builder-service";
import { getGroupView } from "@/server/services/read-service";

const body = z.object({
  expectedVersion: z.number().int().positive(),
  autoPurchase: z.boolean().optional(),
  autoReplace: z.boolean().optional(),
  visibility: z.enum(["public", "invite"]).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const { expectedVersion, ...settings } = await readJson(request, body);
    await updateGroupSettings(providers, ctx, id, expectedVersion, settings);
    return json(await getGroupView(providers, session, id, ctx.shopperId));
  });
}
