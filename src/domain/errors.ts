export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_AMOUNT"
  | "INVALID_ALLOCATION"
  | "ALLOCATION_INVARIANT"
  | "NO_FEASIBLE_GROUP"
  | "NO_REPLACEMENT"
  | "STALE_PROPOSAL"
  | "INCOMPATIBLE_STATE"
  | "NEED_UNAVAILABLE"
  | "OFFER_CHANGED"
  | "INSUFFICIENT_FUNDS"
  | "RETURN_PENDING"
  | "BANK_OUTCOME_UNKNOWN"
  | "NOT_AUTHORIZED"
  | "NOT_FOUND"
  | "SESSION_REQUIRED"
  | "FORBIDDEN_ORIGIN"
  | "SPONSOR_NOT_CONFIGURED"
  | "UPSTREAM_UNAVAILABLE"
  | "DEMO_CONTROLS_DISABLED";

/** Errors carry stable codes; callers branch on `code`, never on message text. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
