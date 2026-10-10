import type { Retailer } from "@/domain/types";

/** Result of a write. Adapters classify; they never throw for a dispatched write. */
export type SubmitOutcome =
  | {
      outcome: "accepted";
      providerId: string;
      status: "pending" | "confirmed";
      providerStatus: string;
    }
  | { outcome: "rejected"; code: string; message: string; httpStatus?: number }
  | { outcome: "unknown"; code: string; message: string; httpStatus?: number };

export type ObservedOutcome =
  | {
      found: true;
      providerId: string;
      status: "pending" | "confirmed" | "failed";
      providerStatus: string;
    }
  | { found: false };

export interface BankingCapabilities {
  /** True only when lookup by correlation value has been verified for this provider. */
  correlationLookup: boolean;
  /** Human-readable description of the provider amount representation. */
  amountUnit: string;
  /** Whether live behavior has been verified with recorded evidence. */
  verified: boolean;
}

export interface TransferInput {
  sessionId: string;
  correlation: string;
  fromAccountRef: string;
  toAccountRef: string;
  amountCents: number;
  description: string;
}

export interface PurchaseInput {
  sessionId: string;
  correlation: string;
  fromAccountRef: string;
  merchantRef: string;
  amountCents: number;
  description: string;
}

export interface BankingProvider {
  readonly name: "nessie" | "rehearsal-ledger";
  readonly capabilities: BankingCapabilities;
  provisionShopper(input: {
    sessionId: string;
    displayName: string;
    openingBalanceCents: number;
  }): Promise<{ customerRef: string; accountRef: string }>;
  provisionCollectionCustomer(input: {
    sessionId: string;
  }): Promise<{ customerRef: string | null }>;
  provisionCollectionAccount(input: {
    sessionId: string;
    groupId: string;
    customerRef: string | null;
  }): Promise<{ accountRef: string }>;
  provisionMerchant(input: {
    sessionId: string;
    retailer: Retailer;
    name: string;
  }): Promise<{ merchantRef: string }>;
  /** Throws ProviderError on read failure. */
  getBalanceCents(accountRef: string): Promise<number>;
  submitTransfer(input: TransferInput): Promise<SubmitOutcome>;
  submitPurchase(input: PurchaseInput): Promise<SubmitOutcome>;
  observe(kind: "transfer" | "purchase", providerId: string): Promise<ObservedOutcome>;
  findByCorrelation(input: {
    kind: "transfer" | "purchase";
    fromAccountRef: string;
    correlation: string;
  }): Promise<ObservedOutcome>;
}

export function operationDescription(correlation: string): string {
  return `CommonCart ${correlation}`;
}
