import type {
  AllocationState,
  ExclusionReason,
  GroupOrigin,
  GroupStatus,
  GroupVisibility,
  Membership,
  OperationKind,
  OperationStatus,
  ProviderMode,
  Retailer,
} from "@/domain/types";

/** JSON shapes returned by the API and rendered by the UI. All money is integer cents. */

export interface SessionView {
  id: string;
  mode: ProviderMode;
  provisioningStatus: "provisioning" | "ready" | "failed";
  provisioningError: string | null;
  scenarioVersion: string;
  catalogVersion: string;
  selectedShopperId: string | null;
  shoppers: {
    id: string;
    personaKey: string;
    displayName: string;
    tagline: string;
    memberships: Membership[];
    bufferCents: number;
    draftNeed: {
      offerKey: string;
      quantity: number;
      maxContributionCents: number;
      pickupWindow: string;
    } | null;
  }[];
  pickupZone: { key: string; label: string };
  pickupWindows: { key: string; startsAt: string; endsAt: string; label: string }[];
  rehearsalFault: "pending" | "unknown" | "reject" | null;
  demoControlsEnabled: boolean;
  sponsorConfigured: boolean;
  providers: {
    banking: {
      name: string;
      correlationLookup: boolean;
      correlationAbsenceIsProof: boolean;
      amountUnit: string;
      verified: boolean;
    };
    analytics: string;
    retail: string;
    healthy: boolean;
    error?: string;
  };
  createdAt: string;
}

export interface OfferView {
  id: string;
  offerKey: string;
  version: number;
  retailer: Retailer;
  retailerLabel: string;
  storeName: string;
  sku: string;
  productFamily: string;
  productName: string;
  unit: string;
  packageQuantity: number;
  itemCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  baselines: { quantity: number; baselineCents: number }[];
  membershipRequired: Membership | null;
  pickupWindows: string[];
  available: boolean;
  expiresAt: string;
  image: string;
  sourceKind: "fixture" | "scraped";
  sourceLabel: string;
  retrievedAt: string;
}

export interface NeedView {
  id: string;
  shopperId: string;
  offerIds: string[];
  quantity: number;
  maxContributionCents: number;
  pickupWindow: string;
  status: "forming" | "reserved" | "withdrawn" | "fulfilled";
  groupId: string | null;
  createdAt: string;
}

export interface ExplanationView {
  status: "ready" | "unavailable";
  source: "template";
  text: string | null;
  proposalVersion: number;
  stale: boolean;
  reason?: string;
}

export interface AllocationView {
  id: string;
  shopperId: string;
  name: string;
  quantity: number;
  contributionCents: number;
  baselineCents: number;
  baselineEstimated: boolean;
  savingsCents: number;
  state: AllocationState;
  consented: boolean;
  isReplacement: boolean;
  isOrganizer: boolean;
  autoPay: boolean;
  contributionStatus: OperationStatus | null;
  returnStatus: OperationStatus | null;
  netContributionCents: number;
}

export interface OperationView {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  amountCents: number;
  shopperName: string | null;
  providerId: string | null;
  providerStatus: string | null;
  attemptCount: number;
  lastError: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupAction =
  | "confirm"
  | "contribute"
  | "withdraw"
  | "replace"
  | "cancel"
  | "purchase"
  | "pickup"
  | "join";

export interface StoreView {
  name: string;
  addressLine: string;
  mapUrl: string;
  /** The bank's merchant record for this store (Nessie merchant ID in sponsor mode). */
  merchantRef: string | null;
}

export interface GroupView {
  id: string;
  /** Where the organizer buys the package. */
  store: StoreView | null;
  origin: GroupOrigin;
  visibility: GroupVisibility;
  inviteCode: string | null;
  autoPurchase: boolean;
  autoReplace: boolean;
  /** Units not yet claimed by current members. */
  remainingUnits: number;
  /** What a non-member could join right now. */
  joinSlot: { mode: "open" } | { mode: "slot"; quantity: number; contributionCents: number } | null;
  status: GroupStatus;
  statusReason: string | null;
  version: number;
  offer: OfferView;
  pickupLabel: string;
  pickupZoneLabel: string;
  organizerShopperId: string | null;
  organizerName: string | null;
  allocations: AllocationView[];
  operations: OperationView[];
  retainedCents: number;
  totalCents: number;
  totalSavingsCents: number;
  collectionBalanceCents: number | null;
  vacancies: number;
  blockers: string[];
  viewer: { shopperId: string | null; allocationId: string | null; actions: GroupAction[] };
  memberActions: Record<string, GroupAction[]>;
  explanation: ExplanationView | null;
  /** Database engine that answered the candidate search, e.g. "Neon Postgres". */
  analytics: { engine: string; candidateCount: number };
  exclusions: { name: string; reason: ExclusionReason }[];
  updatedAt: string;
}

export interface MatchView {
  needId: string;
  groups: GroupView[];
  /** Listed organizer-created groups this request could join instead. */
  openGroups: GroupView[];
  exclusions: {
    name: string;
    offerId: string;
    reason: ExclusionReason;
    minimumShareCents: number;
  }[];
  analytics: { engine: string };
  demand: {
    offerId: string;
    productName: string;
    retailerLabel: string;
    packageQuantity: number;
    openNeeds: number;
    requestedUnits: number;
    fillablePackages: number;
  }[];
}

export interface EventView {
  id: number;
  groupId: string | null;
  seq: number | null;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorView {
  session: SessionView;
  groups: GroupView[];
  events: EventView[];
  balances: { shopperId: string; name: string; balanceCents: number | null }[];
}

export interface LedgerEntryView {
  operationId: string;
  kind: OperationKind;
  /** Relative to the account being viewed. */
  direction: "in" | "out";
  amountCents: number;
  status: OperationStatus;
  /** Null for wallet top-ups and bill payments. */
  groupId: string | null;
  /** The bill a bill payment paid. */
  billRef: string | null;
  label: string;
  shopperName: string | null;
  providerId: string | null;
  providerStatus: string | null;
  /** Result of re-reading the record from the bank just now. */
  check: "verified" | "mismatch" | "missing" | "unresolved" | "unavailable";
  createdAt: string;
}

export interface WalletView {
  shopperId: string;
  name: string;
  provider: string;
  balanceEffects: boolean;
  account: { nickname: string; maskedNumber: string | null; providerBalanceCents: number };
  effectiveBalanceCents: number;
  billsDueCents: number;
  cushionCents: number;
  pendingOutCents: number;
  spendableCents: number;
  nextPickupLabel: string | null;
  bills: {
    id: string;
    payee: string;
    amountCents: number;
    dueDate: string;
    status: string;
    dueBeforePickup: boolean;
    /** Status of this bill's payment from the wallet, if one was made. */
    payment: OperationStatus | null;
  }[];
  activity: LedgerEntryView[];
}

export interface InsightsView {
  /** Database engine that ran the analyses, e.g. "Neon Postgres". */
  engine: string;
  generatedAt: string;
  totals: {
    savingsCents: number;
    completedGroups: number;
    groupsFormed: number;
    fillRatePercent: number;
    shoppersServed: number;
    unitsShared: number;
    openNeeds: number;
    fillablePackages: number;
    collectedCents: number;
    returnedCents: number;
    purchasedCents: number;
  };
  demand: {
    offerId: string;
    productName: string;
    retailerLabel: string;
    pickupLabel: string;
    packageQuantity: number;
    openNeeds: number;
    requestedUnits: number;
    fillablePackages: number;
  }[];
  savings: {
    offerId: string;
    productName: string;
    retailerLabel: string;
    groups: number;
    shoppers: number;
    units: number;
    savingsCents: number;
  }[];
  outcomes: {
    status: string;
    origin: string;
    groups: number;
    averageMembers: number;
    savingsCents: number;
  }[];
  money: { kind: string; status: string; operations: number; amountCents: number }[];
  /** Purchases read back from the bank's merchant records for each store. */
  storeSpending: {
    retailerLabel: string;
    storeName: string;
    purchases: number;
    amountCents: number;
  }[];
  /** Where store spending was read from, e.g. "Capital One Nessie". */
  bankLabel: string;
  summary: { text: string };
}

/** Neon branch snapshots of the demo database. */
export interface SnapshotView {
  id: string;
  name: string;
  createdAt: string;
}

export interface SnapshotStatus {
  available: boolean;
  reason: string | null;
  database: string;
  parentBranch: string | null;
  snapshots: SnapshotView[];
}
