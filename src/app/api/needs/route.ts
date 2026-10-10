import { z } from "zod";
import { parseDollarsToCents } from "@/domain/money";
import { json, personaContext, readJson, route } from "@/server/http";
import { createNeed } from "@/server/services/need-service";

const body = z.object({
  offerId: z.string().min(1),
  quantity: z.number().int(),
  maxContribution: z.string().max(20),
  pickupWindow: z.string().min(1),
});

export async function POST(request: Request) {
  return route(request, async () => {
    const { session, ctx } = await personaContext();
    const input = await readJson(request, body);
    const need = await createNeed(session, ctx.shopperId, {
      offerId: input.offerId,
      quantity: input.quantity,
      maxContributionCents: parseDollarsToCents(input.maxContribution),
      pickupWindow: input.pickupWindow,
    });
    return json(need, 201);
  });
}
