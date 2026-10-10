import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { getGroupView } from "@/server/services/read-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const session = await currentSession();
    const { id } = await params;
    return json(
      await getGroupView(providersFor(session.mode), session, id, session.selectedShopperId),
    );
  });
}
