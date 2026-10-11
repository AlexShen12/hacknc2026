import type { ExplanationEvidence } from "@/domain/explanation";
import type { InsightsEvidence } from "@/domain/insights";
import type { ParseContext } from "@/domain/need-parse";

export interface CandidateQuery {
  sessionId: string;
  offerId: string;
  initiatingNeedId: string;
  initiatingShopperId: string;
  pickupZone: string;
  pickupWindow: string;
  limit: number;
}

export interface CandidateRow {
  needId: string;
  shopperId: string;
  entityVersion: number;
}

export interface DemandRow {
  offerId: string;
  packageQuantity: number;
  openNeeds: number;
  requestedUnits: number;
  fillablePackages: number;
}

export interface InsightsRows {
  demand: {
    offerId: string;
    productName: string;
    retailer: string;
    pickupWindow: string;
    packageQuantity: number;
    openNeeds: number;
    requestedUnits: number;
    fillablePackages: number;
  }[];
  outcomes: {
    status: string;
    origin: string;
    groups: number;
    averageMembers: number;
    savingsCents: number;
  }[];
  savings: {
    offerId: string;
    productName: string;
    retailer: string;
    groups: number;
    shoppers: number;
    units: number;
    savingsCents: number;
  }[];
  money: { kind: string; status: string; operations: number; amountCents: number }[];
  queryIds: string[];
}

export interface AnalyticsProvider {
  readonly name: "postgres";
  queryCandidates(query: CandidateQuery): Promise<{ rows: CandidateRow[]; queryId: string | null }>;
  demandSummary(sessionId: string): Promise<{ rows: DemandRow[]; queryId: string | null }>;
  /** Returns unvalidated text; callers must validate it against the evidence. */
  explain(evidence: ExplanationEvidence): Promise<{ text: unknown; requestId: string | null }>;
  /** Session-scoped community analytics. */
  communityInsights(sessionId: string): Promise<InsightsRows>;
  /** Returns unvalidated text; callers validate amounts against the evidence. */
  summarizeInsights(
    evidence: InsightsEvidence,
  ): Promise<{ text: unknown; requestId: string | null }>;
  /** Plain-English need to a draft; output is untrusted and validated by the caller. */
  parseNeed(input: { text: string; context: ParseContext }): Promise<{
    output: unknown;
    requestId: string | null;
  }>;
}
