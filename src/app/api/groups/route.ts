import { z } from "zod";
import { parseDollarsToCents } from "@/domain/money";
import { json, personaContext, readJson, route } from "@/server/http";
import { createOpenGroup } from "@/server/services/group-builder-service";
import { getGroupView } from "@/server/services/read-service";

const body = z.object({
  offerId: z.string().min(1),
  quantity: z.number().int(),
  maxContribution: z.string().max(20),
  pickupWindow: z.string().min(1),
  visibility: z.enum(["public", "invite"]),
  autoPurchase: z.boolean(),
  autoPay: z.boolean(),
});

/** Organizer creates an open group with their own share. */
export async function POST(request: Request) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const input = await readJson(request, body);
    const groupId = await createOpenGroup(providers, ctx, {
      ...input,
      maxContributionCents: parseDollarsToCents(input.maxContribution),
    });
    return json(await getGroupView(providers, session, groupId, ctx.shopperId), 201);
  });
}
