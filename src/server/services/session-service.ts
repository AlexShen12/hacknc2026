import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import type { ProviderMode, Retailer } from "@/domain/types";
import { formatPickupWindow, RETAILER_LABELS } from "@/lib/format";
import type { SessionView } from "@/lib/view-types";
import { getConfig, isSponsorConfigured } from "@/server/config";
import { getDb } from "@/server/db/client";
import { demoSessions, needs, offers, type PickupWindowRecord, shoppers } from "@/server/db/schema";
import { loadPersonas } from "@/server/fixtures";
import { log } from "@/server/observability/logger";
import { providersFor } from "@/server/providers";
import { runtime } from "@/server/runtime";
import { appendSessionEvent, enqueueNeed, enqueueOffer } from "@/server/services/records";

export type SessionRow = typeof demoSessions.$inferSelect;

export const SESSION_COOKIE = "cc_session";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Create an isolated demo session: personas, offer snapshots, seeded needs and mock accounts.
 * Mode is fixed here and never changes for the life of the session.
 */
export async function createSession(input: {
  mode: ProviderMode;
  previousSessionId?: string | null;
}): Promise<{ session: SessionRow; token: string }> {
  const providers = providersFor(input.mode);
  const catalog = providers.retail.loadCatalog();
  const scenario = loadPersonas(catalog);
  const db = getDb();
  const now = runtime.now();
  const sessionId = runtime.newId("ses");
  const token = randomBytes(32).toString("base64url");

  const base = new Date(now);
  base.setUTCMinutes(0, 0, 0);
  base.setUTCHours(base.getUTCHours() + 1);
  const pickupWindows: PickupWindowRecord[] = catalog.pickupWindows.map((window) => {
    const startsAt = new Date(base.getTime() + window.startOffsetHours * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + window.durationHours * 3_600_000);
    return { key: window.key, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
  });

  const shopperIds = new Map(
    scenario.personas.map((persona) => [persona.key, runtime.newId("shp")]),
  );
  const offerIds = new Map(catalog.offers.map((offer) => [offer.key, runtime.newId("off")]));

  await db.transaction(async (tx) => {
    await tx.insert(demoSessions).values({
      id: sessionId,
      tokenHash: hashToken(token),
      mode: input.mode,
      selectedShopperId: shopperIds.get(scenario.defaultPersona) ?? null,
      scenarioVersion: scenario.scenarioVersion,
      catalogVersion: catalog.fixtureVersion,
      provisioningStatus: "provisioning",
      pickupZone: catalog.pickupZone,
      pickupWindows,
      merchantRefs: {},
      previousSessionId: input.previousSessionId ?? null,
      createdAt: now,
    });
    await tx.insert(shoppers).values(
      scenario.personas.map((persona) => ({
        id: shopperIds.get(persona.key) ?? "",
        sessionId,
        personaKey: persona.key,
        displayName: persona.displayName,
        tagline: persona.tagline,
        openingBalanceCents: persona.openingBalanceCents,
        bufferCents: persona.bufferCents,
        memberships: persona.memberships,
        draftNeed: persona.draftNeed,
        createdAt: now,
      })),
    );
    const offerRows = await tx
      .insert(offers)
      .values(
        catalog.offers.map((offer) => ({
          id: offerIds.get(offer.key) ?? "",
          sessionId,
          offerKey: offer.key,
          version: 1,
          retailer: offer.retailer,
          storeName: offer.storeName,
          sku: offer.sku,
          productFamily: offer.productFamily,
          productName: offer.productName,
          unit: offer.unit,
          packageQuantity: offer.packageQuantity,
          itemCents: offer.itemCents,
          taxCents: offer.taxCents,
          feeCents: offer.feeCents,
          totalCents: offer.itemCents + offer.taxCents + offer.feeCents,
          baselines: offer.baselines,
          membershipRequired: offer.membershipRequired,
          pickupZone: catalog.pickupZone.key,
          pickupWindows: offer.pickupWindows,
          available: offer.available,
          expiresAt: new Date(now.getTime() + offer.expiresInHours * 3_600_000),
          image: offer.image,
          sourceKind: "fixture" as const,
          sourceUrl: null,
          retrievedAt: now,
          fixtureVersion: catalog.fixtureVersion,
        })),
      )
      .returning();
    for (const offer of offerRows) await enqueueOffer(tx, offer);

    for (const persona of scenario.personas) {
      if (!persona.seededNeed) continue;
      const seed = persona.seededNeed;
      const [need] = await tx
        .insert(needs)
        .values({
          id: runtime.newId("need"),
          sessionId,
          shopperId: shopperIds.get(persona.key) ?? "",
          acceptedOfferIds: [offerIds.get(seed.offerKey) ?? ""],
          quantity: seed.quantity,
          maxContributionCents: seed.maxContributionCents,
          pickupZone: catalog.pickupZone.key,
          pickupWindow: seed.pickupWindow,
          status: "forming",
          createdAt: new Date(now.getTime() - seed.minutesBeforeSession * 60_000),
        })
        .returning();
      if (need) await enqueueNeed(tx, need);
    }
    await appendSessionEvent(tx, {
      sessionId,
      actor: "system",
      type: "session_created",
      payload: { mode: input.mode, scenarioVersion: scenario.scenarioVersion },
    });
  });

  // External provisioning happens outside any database transaction.
  try {
    const personaRows = await db.select().from(shoppers).where(eq(shoppers.sessionId, sessionId));
    for (const shopper of personaRows) {
      const refs = await providers.banking.provisionShopper({
        sessionId,
        displayName: shopper.displayName,
        openingBalanceCents: shopper.openingBalanceCents,
      });
      await db
        .update(shoppers)
        .set({ customerRef: refs.customerRef, fundingAccountRef: refs.accountRef })
        .where(eq(shoppers.id, shopper.id));
    }
    const collection = await providers.banking.provisionCollectionCustomer({ sessionId });
    const merchantRefs: Partial<Record<Retailer, string>> = {};
    for (const retailer of new Set(catalog.offers.map((offer) => offer.retailer))) {
      const { merchantRef } = await providers.banking.provisionMerchant({
        sessionId,
        retailer,
        name: RETAILER_LABELS[retailer],
      });
      merchantRefs[retailer] = merchantRef;
    }
    await db
      .update(demoSessions)
      .set({
        provisioningStatus: "ready",
        collectionCustomerRef: collection.customerRef,
        merchantRefs,
      })
      .where(eq(demoSessions.id, sessionId));
  } catch (error) {
    log("error", "session.provisioning_failed", { sessionId, error: String(error) });
    await db
      .update(demoSessions)
      .set({ provisioningStatus: "failed", provisioningError: String(error).slice(0, 300) })
      .where(eq(demoSessions.id, sessionId));
  }

  const [session] = await db.select().from(demoSessions).where(eq(demoSessions.id, sessionId));
  if (!session) throw new Error("Session vanished after creation");
  return { session, token };
}

export async function findSessionByToken(
  token: string | undefined | null,
): Promise<SessionRow | null> {
  if (!token) return null;
  const [session] = await getDb()
    .select()
    .from(demoSessions)
    .where(eq(demoSessions.tokenHash, hashToken(token)));
  return session ?? null;
}

export async function requireSession(token: string | undefined | null): Promise<SessionRow> {
  const session = await findSessionByToken(token);
  if (!session) throw new DomainError("SESSION_REQUIRED", "Start a demo session first.");
  return session;
}

export function requireReady(session: SessionRow): void {
  if (session.provisioningStatus !== "ready") {
    throw new DomainError(
      "UPSTREAM_UNAVAILABLE",
      session.provisioningStatus === "failed"
        ? "This session's mock accounts could not be created. Start a new session."
        : "This session is still being set up.",
    );
  }
}

export function requireSelectedShopper(session: SessionRow): string {
  if (!session.selectedShopperId)
    throw new DomainError("NOT_AUTHORIZED", "Choose a shopper first.");
  return session.selectedShopperId;
}

export async function getShopper(sessionId: string, shopperId: string) {
  const [shopper] = await getDb()
    .select()
    .from(shoppers)
    .where(and(eq(shoppers.sessionId, sessionId), eq(shoppers.id, shopperId)));
  if (!shopper) throw new DomainError("NOT_FOUND", "Shopper not found in this session.");
  return shopper;
}

export async function selectPersona(session: SessionRow, shopperId: string): Promise<void> {
  await getShopper(session.id, shopperId);
  await getDb()
    .update(demoSessions)
    .set({ selectedShopperId: shopperId })
    .where(eq(demoSessions.id, session.id));
}

/** Reset starts a fresh session in the same mode; the old session's records remain as evidence. */
export async function resetSession(session: SessionRow) {
  return createSession({ mode: session.mode, previousSessionId: session.id });
}

export async function getSessionView(session: SessionRow): Promise<SessionView> {
  const config = getConfig();
  const personaRows = await getDb()
    .select()
    .from(shoppers)
    .where(eq(shoppers.sessionId, session.id))
    .orderBy(asc(shoppers.createdAt), asc(shoppers.personaKey));
  const order = loadPersonas().personas.map((persona) => persona.key);
  personaRows.sort((a, b) => order.indexOf(a.personaKey) - order.indexOf(b.personaKey));
  let providerInfo: SessionView["providers"];
  try {
    const providers = providersFor(session.mode);
    providerInfo = {
      banking: { name: providers.banking.name, ...providers.banking.capabilities },
      analytics: providers.analytics.name,
      retail: providers.retail.name,
      healthy: true,
    };
  } catch (error) {
    providerInfo = {
      banking: { name: "unavailable", correlationLookup: false, amountUnit: "", verified: false },
      analytics: "unavailable",
      retail: "fixtures",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    id: session.id,
    mode: session.mode,
    provisioningStatus: session.provisioningStatus,
    provisioningError: session.provisioningError,
    scenarioVersion: session.scenarioVersion,
    catalogVersion: session.catalogVersion,
    selectedShopperId: session.selectedShopperId,
    shoppers: personaRows.map((shopper) => ({
      id: shopper.id,
      personaKey: shopper.personaKey,
      displayName: shopper.displayName,
      tagline: shopper.tagline,
      memberships: shopper.memberships,
      bufferCents: shopper.bufferCents,
      draftNeed: shopper.draftNeed ?? null,
    })),
    pickupZone: session.pickupZone,
    pickupWindows: session.pickupWindows.map((window) => ({
      ...window,
      label: formatPickupWindow(window.startsAt, window.endsAt),
    })),
    rehearsalFault: session.rehearsalFault ?? null,
    demoControlsEnabled: config.DEMO_CONTROLS_ENABLED,
    sponsorConfigured: isSponsorConfigured(),
    providers: providerInfo,
    createdAt: session.createdAt.toISOString(),
  };
}
