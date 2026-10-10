import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { explainGroup } from "@/server/services/explanation-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const session = await currentSession();
    const { id } = await params;
    return json(
      await explainGroup(providersFor(session.mode), session, id, session.selectedShopperId),
    );
  });
}
