/**
 * Explicit live checks (never part of the deterministic test suite).
 * - Capital One Nessie: dedicated sandbox records for every money movement CommonCart makes
 *   (transfers, purchases, deposits, bill payments), each read back by ID and by correlation.
 * - Neon: the application database connection, branch discovery and a snapshot branch that is
 *   created, checked and deleted again.
 * - The featured journey through the application services with live Nessie banking.
 * Prints redacted evidence to record in techContext.md.
 */
import { eq, sql } from "drizzle-orm";
import { databaseHost, getNeonConfig, getSponsorConfig } from "@/server/config";
import { closeDb, getDb } from "@/server/db/client";
import { demoSessions, shoppers } from "@/server/db/schema";
import { loadCatalog } from "@/server/fixtures";
import { redact } from "@/server/observability/logger";
import { setProviderFactory } from "@/server/providers";
import { PostgresAnalyticsProvider } from "@/server/providers/analytics/postgres";
import { NessieBankingProvider } from "@/server/providers/banking/nessie";
import { operationDescription } from "@/server/providers/banking/types";
import { NeonClient } from "@/server/providers/neon";
import { FixtureRetailProvider } from "@/server/providers/retail/fixtures";

if (process.env.RUN_LIVE_SPONSOR_CHECKS !== "true") {
  console.error("Refusing to call live sponsors: set RUN_LIVE_SPONSOR_CHECKS=true explicitly.");
  process.exit(1);
}

const config = getSponsorConfig();
const evidence: Record<string, unknown> = { at: new Date().toISOString() };
const failed = new Set<string>();
const sessionId = `verify_${Date.now()}`;

async function step(name: string, fn: () => Promise<unknown>, needs: string[] = []) {
  const missing = needs.filter((dependency) => failed.has(dependency) || !(dependency in evidence));
  if (missing.length > 0) {
    failed.add(name);
    evidence[name] = { skipped: `requires ${missing.join(", ")}` };
    console.log(`SKIP ${name}: requires ${missing.join(", ")}`);
    return;
  }
  try {
    evidence[name] = await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed.add(name);
    evidence[name] = { error: redact(String(error)) };
    console.log(`FAIL ${name}: ${redact(String(error))}`);
  }
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(`Expectation failed: ${message}`);
}

// --- Nessie adapter checks -------------------------------------------------------------------
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
  merchant = (
    await bank.provisionMerchant({
      sessionId,
      retailer: "walmart",
      store: loadCatalog().stores.walmart,
    })
  ).merchantRef;
  payer = shopper.accountRef;
  collection = account.accountRef;
  const opening = await bank.getBalanceCents(payer);
  expect(opening === 10000, "opening balance reads back unchanged");
  return {
    openingBalanceCents: opening,
    collectionBalanceCents: await bank.getBalanceCents(collection),
  };
});

for (const [name, from, to, correlation] of [
  [
    "nessie.contribution",
    () => payer,
    () => collection,
    operationDescription(`contribution:${sessionId}`),
  ],
  ["nessie.return", () => collection, () => payer, operationDescription(`return:${sessionId}`)],
] as const) {
  await step(name, async () => {
    const submitted = await bank.submitTransfer({
      sessionId,
      correlation,
      fromAccountRef: from(),
      toAccountRef: to(),
      amountCents: 1500,
      description: correlation,
    });
    expect(submitted.outcome === "accepted", `transfer accepted (${JSON.stringify(submitted)})`);
    const observed =
      submitted.outcome === "accepted"
        ? await bank.observe("transfer", submitted.providerId)
        : null;
    const lookup = await bank.findByCorrelation({
      kind: "transfer",
      fromAccountRef: from(),
      correlation,
    });
    expect(Boolean(observed?.found && observed.amountCents === 1500), "transfer reads back by ID");
    expect(lookup.found, "transfer found by correlation lookup");
    return {
      submitted,
      observed,
      correlationLookup: lookup,
      fromBalanceCents: await bank.getBalanceCents(from()),
      toBalanceCents: await bank.getBalanceCents(to()),
    };
  }, ["nessie.provision"]);
}

await step("nessie.purchase", async () => {
  const correlation = operationDescription(`purchase:${sessionId}`);
  const submitted = await bank.submitPurchase({
    sessionId,
    correlation,
    fromAccountRef: payer,
    merchantRef: merchant,
    amountCents: 100,
    description: correlation,
  });
  expect(submitted.outcome === "accepted", `purchase accepted (${JSON.stringify(submitted)})`);
  const observed =
    submitted.outcome === "accepted" ? await bank.observe("purchase", submitted.providerId) : null;
  const lookup = await bank.findByCorrelation({
    kind: "purchase",
    fromAccountRef: payer,
    correlation,
  });
  expect(Boolean(observed?.found), "purchase reads back by ID");
  expect(lookup.found, "purchase found by correlation lookup");
  return {
    submitted,
    observed,
    correlationLookup: lookup,
    payerCents: await bank.getBalanceCents(payer),
  };
}, ["nessie.provision"]);

await step("nessie.bills_and_summary", async () => {
  const dueDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const created = await bank.provisionBill({
    sessionId,
    accountRef: payer,
    payee: "Verify Utility",
    amountCents: 4500,
    dueDate,
  });
  const bills = await bank.listBills(payer);
  const bill = bills.find((item) => item.id === created.billRef);
  expect(
    bill?.amountCents === 4500 && bill.dueDate === dueDate,
    "bill reads back with amount and due date",
  );
  const summary = await bank.getAccountSummary(payer);
  expect(Boolean(summary.maskedNumber?.startsWith("•••• ")), "account number is masked");
  return { bill, summary };
}, ["nessie.provision"]);

await step("nessie.deposit", async () => {
  const correlation = operationDescription(`deposit:${sessionId}`);
  const submitted = await bank.submitDeposit({
    sessionId,
    correlation,
    toAccountRef: payer,
    amountCents: 2500,
    description: correlation,
  });
  expect(submitted.outcome === "accepted", `deposit accepted (${JSON.stringify(submitted)})`);
  const observed =
    submitted.outcome === "accepted" ? await bank.observe("deposit", submitted.providerId) : null;
  const lookup = await bank.findByCorrelation({
    kind: "deposit",
    fromAccountRef: payer,
    correlation,
  });
  expect(Boolean(observed?.found && observed.amountCents === 2500), "deposit reads back by ID");
  expect(lookup.found, "deposit found by correlation lookup");
  return { submitted, observed, correlationLookup: lookup };
}, ["nessie.provision"]);

await step("nessie.bill_payment", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { billRef } = await bank.provisionBill({
    sessionId,
    accountRef: payer,
    payee: "Verify Water",
    amountCents: 3100,
    dueDate: today,
  });
  const correlation = operationDescription(`bill_payment:${billRef}`);
  const submitted = await bank.submitBillPayment({
    sessionId,
    correlation,
    fromAccountRef: payer,
    billRef,
    amountCents: 3100,
    description: correlation,
  });
  expect(submitted.outcome === "accepted", `bill payment accepted (${JSON.stringify(submitted)})`);
  const observed =
    submitted.outcome === "accepted"
      ? await bank.observe("withdrawal", submitted.providerId, payer)
      : null;
  const bill = (await bank.listBills(payer)).find((item) => item.id === billRef);
  expect(Boolean(observed?.found && observed.amountCents === 3100), "payment record reads back");
  expect(bill?.status === "completed", "bill is marked paid");
  return { submitted, observed, billStatus: bill?.status };
}, ["nessie.provision"]);

await step("nessie.merchant_purchases", async () => {
  const purchases = await bank.listMerchantPurchases(merchant);
  expect(
    purchases.some((purchase) => purchase.amountCents === 100),
    "the verification purchase is listed at the merchant",
  );
  return { purchases };
}, ["nessie.purchase"]);

// --- Neon -------------------------------------------------------------------------------------
await step("neon.database", async () => {
  const result = await getDb().execute<{ version: string; database: string }>(
    sql`select version() as version, current_database() as database`,
  );
  const host = databaseHost();
  expect(Boolean(host?.endsWith(".neon.tech")), "DATABASE_URL points at Neon");
  return { host: host?.replace(/^[^.]+/, "ep-…"), ...result.rows[0] };
});

await step("neon.snapshot_branch", async () => {
  const neonConfig = getNeonConfig();
  if (!neonConfig) throw new Error("NEON_API_KEY and NEON_PROJECT_ID are required");
  const neon = new NeonClient(neonConfig);
  const parent = await neon.branchForHost(databaseHost() ?? "");
  expect(parent !== null, "found the branch serving DATABASE_URL");
  const branch = await neon.createBranch(`commoncart-verify-${Date.now()}`, parent ?? "");
  const listed = (await neon.listBranches()).some((item) => item.id === branch.id);
  // Clean up: this verification branch is not a demo snapshot.
  await neon.deleteBranch(branch.id);
  expect(listed, "snapshot branch is listed after creation");
  return { parent, created: { id: branch.id, name: branch.name }, deleted: true };
}, ["neon.database"]);

// --- Full journey with live Nessie banking ------------------------------------------------------
// Runs against TEST_DATABASE_URL so verification never adds sessions to the demo database.
await step("journey.nessie_funded_dropout", async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL is required for the journey check");
  await closeDb();
  process.env.DATABASE_URL = testUrl;
  setProviderFactory((mode) => ({
    mode,
    banking: new NessieBankingProvider(config.nessie),
    analytics: new PostgresAnalyticsProvider(getDb()),
    retail: new FixtureRetailProvider(),
  }));
  const { runFeaturedJourney } = await import("./journey");
  const db = getDb();
  const result = await runFeaturedJourney({
    loadSession: async (id) => {
      const [row] = await db.select().from(demoSessions).where(eq(demoSessions.id, id));
      if (!row) throw new Error("session missing");
      return row;
    },
    shopperIds: async (id) =>
      Object.fromEntries(
        (await db.select().from(shoppers).where(eq(shoppers.sessionId, id))).map((row) => [
          row.personaKey,
          row.id,
        ]),
      ),
  });
  expect(result.finalStatus === "fulfilled", `journey fulfilled (got ${result.finalStatus})`);
  expect(result.totalSavingsCents === 2800, "total savings 2800 cents");
  return result;
}, ["nessie.contribution"]);

console.log(redact(JSON.stringify(evidence, null, 2)));
await closeDb();
process.exit(failed.size > 0 ? 1 : 0);
