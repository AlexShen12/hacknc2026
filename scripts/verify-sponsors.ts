/**
 * Explicit live sponsor checks (never part of the deterministic test suite). Creates dedicated
 * Nessie sandbox records, moves known amounts and observes them; runs Snowflake SQL and Cortex.
 * Prints redacted evidence to record in techContext.md.
 */
import { getSponsorConfig } from "@/server/config";
import { redact } from "@/server/observability/logger";
import {
  SnowflakeAnalyticsProvider,
  SnowflakeSqlClient,
} from "@/server/providers/analytics/snowflake";
import { NessieBankingProvider } from "@/server/providers/banking/nessie";

if (process.env.RUN_LIVE_SPONSOR_CHECKS !== "true") {
  console.error("Refusing to call live sponsors: set RUN_LIVE_SPONSOR_CHECKS=true explicitly.");
  process.exit(1);
}

const config = getSponsorConfig();
const evidence: Record<string, unknown> = { at: new Date().toISOString() };
const sessionId = `verify_${Date.now()}`;

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    evidence[name] = await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    evidence[name] = { error: redact(String(error)) };
    console.log(`FAIL ${name}: ${redact(String(error))}`);
  }
}

const bank = new NessieBankingProvider(config.nessie);
let payer = "";
let collection = "";
let merchant = "";
await step("nessie.provision", async () => {
  const shopper = await bank.provisionShopper({
    sessionId,
    displayName: "Verify",
    openingBalanceCents: 10000,
  });
  const { customerRef } = await bank.provisionCollectionCustomer({ sessionId });
  const account = await bank.provisionCollectionAccount({
    sessionId,
    groupId: sessionId,
    customerRef,
  });
  merchant = (await bank.provisionMerchant({ sessionId, retailer: "walmart", name: "Walmart" }))
    .merchantRef;
  payer = shopper.accountRef;
  collection = account.accountRef;
  return {
    openingBalanceCents: await bank.getBalanceCents(payer),
    collectionBalanceCents: await bank.getBalanceCents(collection),
  };
});
await step("nessie.contribution", async () => {
  const submitted = await bank.submitTransfer({
    sessionId,
    correlation: "verify-contribution",
    fromAccountRef: payer,
    toAccountRef: collection,
    amountCents: 1500,
    description: "CommonCart verify-contribution",
  });
  const observed =
    submitted.outcome === "accepted" ? await bank.observe("transfer", submitted.providerId) : null;
  return {
    submitted,
    observed,
    payerCents: await bank.getBalanceCents(payer),
    collectionCents: await bank.getBalanceCents(collection),
  };
});
await step("nessie.return", async () => {
  const submitted = await bank.submitTransfer({
    sessionId,
    correlation: "verify-return",
    fromAccountRef: collection,
    toAccountRef: payer,
    amountCents: 1500,
    description: "CommonCart verify-return",
  });
  const observed =
    submitted.outcome === "accepted" ? await bank.observe("transfer", submitted.providerId) : null;
  return {
    submitted,
    observed,
    payerCents: await bank.getBalanceCents(payer),
    collectionCents: await bank.getBalanceCents(collection),
  };
});
await step("nessie.purchase", async () => {
  const submitted = await bank.submitPurchase({
    sessionId,
    correlation: "verify-purchase",
    fromAccountRef: payer,
    merchantRef: merchant,
    amountCents: 100,
    description: "CommonCart verify-purchase",
  });
  const observed =
    submitted.outcome === "accepted" ? await bank.observe("purchase", submitted.providerId) : null;
  return { submitted, observed, payerCents: await bank.getBalanceCents(payer) };
});

const sql = new SnowflakeSqlClient(config.snowflake);
await step("snowflake.sql", async () => {
  const result = await sql.execute("SELECT CURRENT_VERSION() AS VERSION, CURRENT_ROLE() AS ROLE");
  return { statementHandle: result.statementHandle, rows: result.rows };
});
const analytics = new SnowflakeAnalyticsProvider(config.snowflake);
await step("snowflake.sync_and_query", async () => {
  await analytics.sync([
    {
      id: 1,
      sessionId,
      entityType: "need",
      entityId: `${sessionId}_need`,
      entityVersion: 1,
      payload: {
        shopper_id: "verify",
        accepted_offer_ids: ["verify_offer"],
        quantity: 6,
        max_contribution_cents: 2000,
        pickup_zone: "zone",
        pickup_window: "window-a",
        status: "forming",
        created_at: new Date().toISOString(),
      },
    },
  ]);
  return analytics.queryCandidates({
    sessionId,
    offerId: "verify_offer",
    initiatingNeedId: "none",
    initiatingShopperId: "none",
    pickupZone: "zone",
    pickupWindow: "window-a",
    limit: 11,
  });
});
await step("cortex.explain", async () =>
  analytics.explain({
    groupId: sessionId,
    proposalVersion: 1,
    productName: "Everyday Paper Towels",
    retailerLabel: "Walmart",
    unit: "rolls",
    packageQuantity: 24,
    totalCents: 6000,
    taxCents: 0,
    feeCents: 0,
    pickupLabel: "Saturday morning",
    sourceLabel: "fixture",
    totalSavingsCents: 1400,
    excluded: [],
    members: ["A", "B"].map((name) => ({
      name,
      quantity: 12,
      contributionCents: 3000,
      baselineCents: 3700,
      savingsCents: 700,
    })),
  }),
);

console.log(redact(JSON.stringify(evidence, null, 2)));
