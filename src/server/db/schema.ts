import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ComparisonBaseline,
  ExclusionReason,
  GroupStatus,
  Membership,
  NeedStatus,
  OperationKind,
  OperationStatus,
  ProviderMode,
  Retailer,
} from "@/domain/types";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export interface PickupWindowRecord {
  key: string;
  startsAt: string;
  endsAt: string;
}

export interface DraftNeed {
  offerKey: string;
  quantity: number;
  maxContributionCents: number;
  pickupWindow: string;
}

export const demoSessions = pgTable(
  "demo_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    mode: text("mode").$type<ProviderMode>().notNull(),
    selectedShopperId: text("selected_shopper_id"),
    scenarioVersion: text("scenario_version").notNull(),
    catalogVersion: text("catalog_version").notNull(),
    provisioningStatus: text("provisioning_status")
      .$type<"provisioning" | "ready" | "failed">()
      .notNull(),
    provisioningError: text("provisioning_error"),
    pickupZone: jsonb("pickup_zone").$type<{ key: string; label: string }>().notNull(),
    pickupWindows: jsonb("pickup_windows").$type<PickupWindowRecord[]>().notNull(),
    rehearsalFault: text("rehearsal_fault").$type<"pending" | "unknown" | "reject">(),
    collectionCustomerRef: text("collection_customer_ref"),
    merchantRefs: jsonb("merchant_refs").$type<Partial<Record<Retailer, string>>>().notNull(),
    previousSessionId: text("previous_session_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("demo_sessions_token_hash_key").on(table.tokenHash),
    check("demo_sessions_mode_check", sql`${table.mode} in ('sponsor', 'rehearsal')`),
  ],
);

export const shoppers = pgTable(
  "shoppers",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    personaKey: text("persona_key").notNull(),
    displayName: text("display_name").notNull(),
    tagline: text("tagline").notNull(),
    customerRef: text("customer_ref"),
    fundingAccountRef: text("funding_account_ref"),
    openingBalanceCents: integer("opening_balance_cents").notNull(),
    bufferCents: integer("buffer_cents").notNull(),
    memberships: jsonb("memberships").$type<Membership[]>().notNull(),
    draftNeed: jsonb("draft_need").$type<DraftNeed | null>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("shoppers_session_persona_key").on(table.sessionId, table.personaKey),
    check("shoppers_buffer_check", sql`${table.bufferCents} >= 0`),
  ],
);

export const offers = pgTable(
  "offers",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    offerKey: text("offer_key").notNull(),
    version: integer("version").notNull().default(1),
    retailer: text("retailer").$type<Retailer>().notNull(),
    storeName: text("store_name").notNull(),
    sku: text("sku").notNull(),
    productFamily: text("product_family").notNull(),
    productName: text("product_name").notNull(),
    unit: text("unit").notNull(),
    packageQuantity: integer("package_quantity").notNull(),
    itemCents: integer("item_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    baselines: jsonb("baselines").$type<ComparisonBaseline[]>().notNull(),
    membershipRequired: text("membership_required").$type<Membership>(),
    pickupZone: text("pickup_zone").notNull(),
    pickupWindows: jsonb("pickup_windows").$type<string[]>().notNull(),
    available: boolean("available").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    image: text("image").notNull(),
    sourceKind: text("source_kind").$type<"fixture" | "scraped">().notNull(),
    sourceUrl: text("source_url"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    fixtureVersion: text("fixture_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("offers_session_key").on(table.sessionId, table.offerKey),
    check(
      "offers_total_check",
      sql`${table.totalCents} = ${table.itemCents} + ${table.taxCents} + ${table.feeCents}`,
    ),
    check("offers_package_check", sql`${table.packageQuantity} > 0`),
  ],
);

export const needs = pgTable(
  "needs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id),
    acceptedOfferIds: jsonb("accepted_offer_ids").$type<string[]>().notNull(),
    quantity: integer("quantity").notNull(),
    maxContributionCents: integer("max_contribution_cents").notNull(),
    pickupZone: text("pickup_zone").notNull(),
    pickupWindow: text("pickup_window").notNull(),
    status: text("status").$type<NeedStatus>().notNull(),
    reservedGroupId: text("reserved_group_id"),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("needs_session_status_idx").on(table.sessionId, table.status, table.createdAt),
    check("needs_quantity_check", sql`${table.quantity} > 0`),
    check("needs_max_check", sql`${table.maxContributionCents} >= 0`),
    check(
      "needs_reservation_check",
      sql`(${table.status} = 'reserved') = (${table.reservedGroupId} is not null)`,
    ),
  ],
);

export interface OfferSnapshot {
  id: string;
  offerKey: string;
  version: number;
  retailer: Retailer;
  storeName: string;
  productName: string;
  unit: string;
  packageQuantity: number;
  itemCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  membershipRequired: Membership | null;
  sourceKind: "fixture" | "scraped";
  retrievedAt: string;
  expiresAt: string;
  image: string;
}

export interface AnalyticsSnapshot {
  source: "snowflake" | "local";
  queryId: string | null;
  candidateCount: number;
  syncedThroughOutboxId: number | null;
  queriedAt: string;
  exclusions: { needId: string; shopperId: string; reason: ExclusionReason }[];
}

export interface StoredExplanation {
  proposalVersion: number;
  source: "cortex" | "template";
  text: string | null;
  status: "ready" | "unavailable";
  reason?: string;
  requestId?: string | null;
  generatedAt: string;
}

export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    offerSnapshot: jsonb("offer_snapshot").$type<OfferSnapshot>().notNull(),
    status: text("status").$type<GroupStatus>().notNull(),
    statusReason: text("status_reason"),
    version: integer("version").notNull().default(1),
    initiatingNeedId: text("initiating_need_id").notNull(),
    organizerShopperId: text("organizer_shopper_id"),
    collectionAccountRef: text("collection_account_ref"),
    analyticsSnapshot: jsonb("analytics_snapshot").$type<AnalyticsSnapshot>().notNull(),
    totalCents: integer("total_cents").notNull(),
    packageQuantity: integer("package_quantity").notNull(),
    pickupZone: text("pickup_zone").notNull(),
    pickupWindow: text("pickup_window").notNull(),
    eventSeq: integer("event_seq").notNull().default(0),
    explanation: jsonb("explanation").$type<StoredExplanation | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("groups_session_idx").on(table.sessionId, table.createdAt)],
);

export interface ConsentRecord {
  offerId: string;
  offerVersion: number;
  quantity: number;
  contributionCents: number;
  pickupZone: string;
  pickupWindow: string;
  consentedAt: string;
}

export const allocations = pgTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    needId: text("need_id")
      .notNull()
      .references(() => needs.id),
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id),
    position: integer("position").notNull(),
    quantity: integer("quantity").notNull(),
    contributionCents: integer("contribution_cents").notNull(),
    baselineCents: integer("baseline_cents").notNull(),
    savingsCents: integer("savings_cents").notNull(),
    state: text("state").$type<"active" | "departing" | "departed" | "picked_up">().notNull(),
    consent: jsonb("consent").$type<ConsentRecord | null>(),
    contributionOperationId: text("contribution_operation_id"),
    returnOperationId: text("return_operation_id"),
    replacesAllocationId: text("replaces_allocation_id"),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("allocations_group_need_key").on(table.groupId, table.needId),
    index("allocations_group_idx").on(table.groupId),
    check("allocations_savings_check", sql`${table.savingsCents} > 0`),
  ],
);

export interface OperationError {
  code: string;
  message: string;
  httpStatus?: number;
}

export const bankOperations = pgTable(
  "bank_operations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    allocationId: text("allocation_id"),
    kind: text("kind").$type<OperationKind>().notNull(),
    operationKey: text("operation_key").notNull(),
    amountCents: integer("amount_cents").notNull(),
    fromAccountRef: text("from_account_ref").notNull(),
    toRef: text("to_ref").notNull(),
    status: text("status").$type<OperationStatus>().notNull(),
    providerId: text("provider_id"),
    providerStatus: text("provider_status"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: jsonb("last_error").$type<OperationError | null>(),
    relatedOperationId: text("related_operation_id"),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("bank_operations_key").on(table.operationKey),
    index("bank_operations_group_idx").on(table.groupId),
    check("bank_operations_amount_check", sql`${table.amountCents} > 0`),
  ],
);

export const operationAttempts = pgTable(
  "operation_attempts",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => bankOperations.id),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
    providerId: text("provider_id"),
    error: jsonb("error").$type<OperationError | null>(),
  },
  (table) => [
    uniqueIndex("operation_attempts_number_key").on(table.operationId, table.attemptNumber),
  ],
);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    groupId: text("group_id"),
    seq: integer("seq"),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("workflow_events_group_seq_key").on(table.groupId, table.seq),
    index("workflow_events_session_idx").on(table.sessionId, table.id),
  ],
);

export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    entityType: text("entity_type").$type<"offer" | "need" | "group" | "operation">().notNull(),
    entityId: text("entity_id").notNull(),
    entityVersion: integer("entity_version").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"pending" | "delivered" | "failed">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [index("sync_outbox_pending_idx").on(table.sessionId, table.status, table.id)],
);

/** Rehearsal-only banking simulation. Sponsor sessions never read or write these tables. */
export const rehearsalAccounts = pgTable(
  "rehearsal_accounts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    ownerKind: text("owner_kind").$type<"shopper" | "collection" | "merchant">().notNull(),
    label: text("label").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    createdAt: createdAt(),
  },
  (table) => [check("rehearsal_accounts_balance_check", sql`${table.balanceCents} >= 0`)],
);

export const rehearsalTransactions = pgTable(
  "rehearsal_transactions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => demoSessions.id),
    kind: text("kind").$type<"transfer" | "purchase">().notNull(),
    payerAccountId: text("payer_account_id")
      .notNull()
      .references(() => rehearsalAccounts.id),
    payeeAccountId: text("payee_account_id")
      .notNull()
      .references(() => rehearsalAccounts.id),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<"pending" | "executed" | "cancelled">().notNull(),
    description: text("description").notNull(),
    createdAt: createdAt(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [index("rehearsal_transactions_description_idx").on(table.description)],
);
