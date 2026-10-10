import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { demoSessions, groups, needs, shoppers } from "@/server/db/schema";
import { providersFor } from "@/server/providers";
import type { ActionContext } from "@/server/services/funding-service";
import { getGroupView } from "@/server/services/read-service";
import { createSession, type SessionRow } from "@/server/services/session-service";

export type Persona = "alex" | "jordan" | "sam" | "riley" | "taylor" | "casey";

export async function startScenario() {
  const { session } = await createSession({ mode: "rehearsal" });
  if (session.provisioningStatus !== "ready") throw new Error("Provisioning failed");
  const rows = await getDb().select().from(shoppers).where(eq(shoppers.sessionId, session.id));
  const ids = Object.fromEntries(rows.map((row) => [row.personaKey, row.id])) as Record<
    Persona,
    string
  >;
  const providers = providersFor("rehearsal");

  const fresh = async (): Promise<SessionRow> => {
    const [row] = await getDb().select().from(demoSessions).where(eq(demoSessions.id, session.id));
    if (!row) throw new Error("session missing");
    return row;
  };
  const ctx = async (persona: Persona): Promise<ActionContext> => ({
    session: await fresh(),
    shopperId: ids[persona],
    actor: ids[persona],
  });
  const view = async (groupId: string, persona: Persona = "alex") =>
    getGroupView(providers, await fresh(), groupId, ids[persona]);
  const version = async (groupId: string) => {
    const [row] = await getDb().select().from(groups).where(eq(groups.id, groupId));
    if (!row) throw new Error("group missing");
    return row.version;
  };
  const balance = async (persona: Persona) => {
    const [row] = await getDb().select().from(shoppers).where(eq(shoppers.id, ids[persona]));
    return providers.banking.getBalanceCents(row?.fundingAccountRef ?? "");
  };
  const needOf = async (persona: Persona) => {
    const [row] = await getDb()
      .select()
      .from(needs)
      .where(and(eq(needs.sessionId, session.id), eq(needs.shopperId, ids[persona])));
    return row;
  };
  const offerId = async () => {
    const need = await needOf("jordan");
    return need?.acceptedOfferIds[0] ?? "";
  };
  const pickupWindow = session.pickupWindows[0]?.key ?? "window-a";
  return {
    session,
    ids,
    providers,
    fresh,
    ctx,
    view,
    version,
    balance,
    needOf,
    offerId,
    pickupWindow,
  };
}

export type Scenario = Awaited<ReturnType<typeof startScenario>>;
