import { json, personaContext, readJson, route, versionBody } from "@/server/http";
import { contribute } from "@/server/services/funding-service";
import { getGroupView } from "@/server/services/read-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const { expectedVersion } = await readJson(request, versionBody);
    const operation = await contribute(providers, ctx, id, expectedVersion);
    const group = await getGroupView(providers, session, id, ctx.shopperId);
    // A pending or unknown outcome is accepted, not failed: never invite a fresh payment.
    const settled = operation.status === "confirmed" || operation.status === "failed";
    return json(
      { group, operationId: operation.id, operationStatus: operation.status },
      settled ? 200 : 202,
    );
  });
}
