import type {
  ExclusionReason,
  GroupStatus,
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
    banking: { name: string; correlationLookup: boolean; amountUnit: string; verified: boolean };
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
  source: "cortex" | "template";
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
  savingsCents: number;
  state: "active" | "departing" | "departed" | "picked_up";
  consented: boolean;
  isReplacement: boolean;
  isOrganizer: boolean;
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
  | "pickup";

export interface GroupView {
  id: string;
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
  analytics: { source: "snowflake" | "local"; queryId: string | null; candidateCount: number };
  exclusions: { name: string; reason: ExclusionReason }[];
  updatedAt: string;
}

export interface MatchView {
  needId: string;
  groups: GroupView[];
  exclusions: {
    name: string;
    offerId: string;
    reason: ExclusionReason;
    minimumShareCents: number;
  }[];
  analytics: {
    source: "snowflake" | "local";
    queryIds: string[];
    syncedThroughOutboxId: number | null;
  };
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
  outbox: Partial<Record<"pending" | "delivered" | "failed", number>>;
  balances: { shopperId: string; name: string; balanceCents: number | null }[];
}
