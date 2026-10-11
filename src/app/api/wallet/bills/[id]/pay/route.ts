import { json, personaContext, route } from "@/server/http";
import { getWallet, payBill } from "@/server/services/wallet-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const operation = await payBill(providers, ctx, id);
    const wallet = await getWallet(providers, session, ctx.shopperId);
    const settled = operation.status === "confirmed" || operation.status === "failed";
    return json({ wallet, operationStatus: operation.status }, settled ? 200 : 202);
  });
}
