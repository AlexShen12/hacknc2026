import { currentSession, json, route } from "@/server/http";
import { resolveInvite } from "@/server/services/group-builder-service";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(request, async () => {
    const { code } = await params;
    return json({ groupId: await resolveInvite(await currentSession(), code) });
  });
}
