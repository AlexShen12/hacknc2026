import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { getOperatorView } from "@/server/services/read-service";

export async function GET(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    return json(await getOperatorView(providersFor(session.mode), session));
  });
}
