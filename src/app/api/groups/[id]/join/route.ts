import { z } from "zod";
import { parseDollarsToCents } from "@/domain/money";
import { json, personaContext, readJson, route } from "@/server/http";
import { joinGroup } from "@/server/services/group-builder-service";
import { getGroupView } from "@/server/services/read-service";

const body = z.object({
  expectedVersion: z.number().int().positive(),
  quantity: z.number().int(),
  maxContribution: z.string().max(20),
  autoPay: z.boolean(),
  inviteCode: z.string().max(32).nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const { session, providers, ctx } = await personaContext();
    const { id } = await params;
    const input = await readJson(request, body);
    await joinGroup(providers, ctx, id, input.expectedVersion, {
      quantity: input.quantity,
      maxContributionCents: parseDollarsToCents(input.maxContribution),
      autoPay: input.autoPay,
      inviteCode: input.inviteCode ?? null,
    });
    return json(await getGroupView(providers, session, id, ctx.shopperId));
  });
}
