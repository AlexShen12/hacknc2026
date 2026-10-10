import type { ExplanationEvidence } from "@/domain/explanation";

export interface OutboxRecord {
  id: number;
  sessionId: string;
  entityType: "offer" | "need" | "group" | "operation";
  entityId: string;
  entityVersion: number;
  payload: Record<string, unknown>;
}

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

export interface AnalyticsProvider {
  readonly name: "snowflake" | "local";
  /** Deliver records; throws ProviderError on failure so the outbox keeps them pending. */
  sync(records: OutboxRecord[]): Promise<{ deliveredIds: number[] }>;
  queryCandidates(query: CandidateQuery): Promise<{ rows: CandidateRow[]; queryId: string | null }>;
  demandSummary(sessionId: string): Promise<{ rows: DemandRow[]; queryId: string | null }>;
  /** Returns unvalidated text; callers must validate it against the evidence. */
  explain(evidence: ExplanationEvidence): Promise<{ text: unknown; requestId: string | null }>;
}
