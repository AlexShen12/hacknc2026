import { currentSession, json, route } from "@/server/http";
import { listOffers } from "@/server/services/need-service";

export async function GET(request: Request) {
  return route(request, async () => json(await listOffers((await currentSession()).id)));
}
