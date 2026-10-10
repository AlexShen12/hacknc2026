import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { reconcileOperation } from "@/server/services/funding-service";
import { getGroupView } from "@/server/services/read-service";
import { requireReady } from "@/server/services/session-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const session = await currentSession();
    requireReady(session);
    const { id } = await params;
    const providers = providersFor(session.mode);
    const operation = await reconcileOperation(providers, session, id);
    const group = await getGroupView(
      providers,
      session,
      operation.groupId,
      session.selectedShopperId,
    );
    const settled = operation.status === "confirmed" || operation.status === "failed";
    return json(
      { group, operationId: operation.id, operationStatus: operation.status },
      settled ? 200 : 202,
    );
  });
}
