import { json, personaContext, route } from "@/server/http";
import { getWallet } from "@/server/services/wallet-service";

export async function GET(request: Request) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    return json(await getWallet(providers, session, ctx.shopperId));
  });
}
