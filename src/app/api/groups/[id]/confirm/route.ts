import { json, personaContext, readJson, route, versionBody } from "@/server/http";
import { getGroupView } from "@/server/services/read-service";
import { confirmTerms } from "@/server/services/workflow-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const { expectedVersion } = await readJson(request, versionBody);
    await confirmTerms(providers, ctx, id, expectedVersion);
    return json(await getGroupView(providers, session, id, ctx.shopperId));
  });
}
