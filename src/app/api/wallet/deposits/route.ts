import { z } from "zod";
import { parseDollarsToCents } from "@/domain/money";
import { json, personaContext, readJson, route } from "@/server/http";
import { addFunds, getWallet } from "@/server/services/wallet-service";

const body = z.object({
  amount: z.string().max(20),
  /** Client-generated key so a double-submitted form records one deposit. */
  requestKey: z.string().min(8).max(64),
});

export async function POST(request: Request) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const input = await readJson(request, body);
    const operation = await addFunds(providers, ctx, {
      amountCents: parseDollarsToCents(input.amount),
      requestKey: input.requestKey,
    });
    const wallet = await getWallet(providers, session, ctx.shopperId);
    const settled = operation.status === "confirmed" || operation.status === "failed";
    return json({ wallet, operationStatus: operation.status }, settled ? 200 : 202);
  });
}
