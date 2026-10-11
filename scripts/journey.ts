/**
 * The featured funded-dropout journey, driven through the application services. Used by
 * `verify:sponsors` to exercise live providers end to end; provider choice comes from the active
 * provider factory.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { groups } from "@/server/db/schema";
import { providersFor } from "@/server/providers";
import { effectiveBalanceCents } from "@/server/services/balance-service";
import { type ActionContext, contribute } from "@/server/services/funding-service";
import { getInsights } from "@/server/services/insights-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { getGroupView } from "@/server/services/read-service";
import { createSession, type SessionRow } from "@/server/services/session-service";
import { getWallet } from "@/server/services/wallet-service";
import {
  confirmPickup,
  confirmTerms,
  purchase,
  withdraw,
} from "@/server/services/workflow-service";

type Persona = "alex" | "jordan" | "sam" | "riley" | "taylor" | "casey";

export async function runFeaturedJourney(deps: {
  loadSession: (id: string) => Promise<SessionRow>;
  shopperIds: (sessionId: string) => Promise<Record<string, string>>;
}) {
  const { session: created } = await createSession({ mode: "sponsor" });
  if (created.provisioningStatus !== "ready") {
    throw new Error(`Provisioning failed: ${created.provisioningError}`);
  }
  const providers = providersFor("sponsor");
  const ids = (await deps.shopperIds(created.id)) as Record<Persona, string>;
  const ctx = async (persona: Persona): Promise<ActionContext> => ({
    session: await deps.loadSession(created.id),
    shopperId: ids[persona],
    actor: `verify:${persona}`,
  });
  const version = async (groupId: string) => {
    const [row] = await getDb().select().from(groups).where(eq(groups.id, groupId));
    if (!row) throw new Error("group missing");
    return row.version;
  };
  const steps: Record<string, unknown> = {};

  const alex = await ctx("alex");
  const offers = await getDb().query.offers.findMany({
    where: (table, { and, eq: equal }) =>
      and(equal(table.sessionId, created.id), equal(table.offerKey, "wm-paper-towels-24")),
  });
  const offer = offers[0];
  if (!offer) throw new Error("featured offer missing");
  const need = await createNeed(alex.session, alex.shopperId, {
    offerId: offer.id,
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: created.pickupWindows[0]?.key ?? "window-a",
  });
  const match = await runMatching(providers, alex, need.id);
  const groupId = match.groups[0]?.id;
  if (!groupId) throw new Error("no proposal");
  steps.members = match.groups[0]?.allocations.map((row) => row.name);

  for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
    await confirmTerms(providers, await ctx(persona), groupId, await version(groupId));
  }
  for (const persona of ["alex", "jordan"] as Persona[]) {
    await contribute(providers, await ctx(persona), groupId, await version(groupId));
  }
  steps.afterTwoContributions = (
    await getGroupView(providers, await ctx("alex").then((c) => c.session), groupId, ids.alex)
  ).retainedCents;

  await withdraw(providers, await ctx("jordan"), groupId, await version(groupId));
  // Auto-replacement offers Jordan's exact share to Casey; Casey confirms for themselves.
  await confirmTerms(providers, await ctx("casey"), groupId, await version(groupId));
  for (const persona of ["casey", "sam", "riley"] as Persona[]) {
    await contribute(providers, await ctx(persona), groupId, await version(groupId));
  }
  await purchase(providers, await ctx("alex"), groupId, await version(groupId));
  for (const persona of ["alex", "sam", "riley", "casey"] as Persona[]) {
    await confirmPickup(providers, await ctx(persona), groupId, await version(groupId));
  }

  const session = await deps.loadSession(created.id);
  const view = await getGroupView(providers, session, groupId, ids.alex);
  const jordanAccount = (
    await getDb().query.shoppers.findFirst({
      where: (table, { eq: equal }) => equal(table.id, ids.jordan),
    })
  )?.fundingAccountRef;
  const wallet = await getWallet(providers, session, ids.jordan);
  const insights = await getInsights(providers, session);
  return {
    sessionId: created.id,
    wallet: {
      spendableCents: wallet.spendableCents,
      bills: wallet.bills.length,
      activity: wallet.activity.map((row) => [row.kind, row.direction, row.check]),
    },
    insights: {
      engine: insights.engine,
      totals: insights.totals,
      storeSpending: insights.storeSpending,
    },
    groupId,
    finalStatus: view.status,
    totalSavingsCents: view.totalSavingsCents,
    collectionBalanceCents: view.collectionBalanceCents,
    jordanEffectiveBalanceCents: jordanAccount
      ? await effectiveBalanceCents(providers, created.id, jordanAccount)
      : null,
    operations: view.operations.map((operation) => ({
      kind: operation.kind,
      shopper: operation.shopperName,
      amountCents: operation.amountCents,
      status: operation.status,
      providerId: operation.providerId,
      providerStatus: operation.providerStatus,
    })),
    steps,
  };
}
