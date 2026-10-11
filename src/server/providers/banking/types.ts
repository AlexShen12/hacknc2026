import type { OperationKind, Retailer } from "@/domain/types";

/** The provider record that represents each kind of money movement. */
export type RecordKind = "transfer" | "purchase" | "deposit" | "withdrawal";

export function recordKindFor(kind: OperationKind): RecordKind {
  switch (kind) {
    case "purchase":
      return "purchase";
    case "deposit":
      return "deposit";
    case "bill_payment":
      return "withdrawal";
    default:
      return "transfer";
  }
}

/** Placeholder account for money arriving from or leaving to the outside world. */
export const OUTSIDE_ACCOUNT = "outside";

export interface StoreLocation {
  name: string;
  address: { streetNumber: string; streetName: string; city: string; state: string; zip: string };
  geocode: { lat: number; lng: number };
}

export interface MerchantPurchase {
  id: string;
  amountCents: number;
  status: string;
  date: string;
}

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
      /** Amount recorded by the provider, in cents, when the provider reports it. */
      amountCents?: number;
    }
  | { found: false };

export interface BankingCapabilities {
  /** True only when lookup by correlation value has been verified for this provider. */
  correlationLookup: boolean;
  /**
   * True only when a lookup that finds nothing proves the write never executed (the provider's
   * own ledger is authoritative and immediately consistent). Otherwise "not found" stays unknown.
   */
  correlationAbsenceIsProof: boolean;
  /** Human-readable description of the provider amount representation. */
  amountUnit: string;
  /** Whether live behavior has been verified with recorded evidence. */
  verified: boolean;
  /**
   * True when writes change the provider's account balances. When false (observed for Nessie),
   * effective balances are the opening balance adjusted by confirmed, provider-verified records.
   */
  balanceEffects: boolean;
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

export interface BillRecord {
  id: string;
  payee: string;
  amountCents: number;
  /** Next payment date, YYYY-MM-DD. */
  dueDate: string;
  status: string;
}

export interface AccountSummary {
  balanceCents: number;
  nickname: string;
  /** Last four digits only, e.g. "•••• 4836"; null when the provider has no account number. */
  maskedNumber: string | null;
}

export interface DepositInput {
  sessionId: string;
  correlation: string;
  toAccountRef: string;
  amountCents: number;
  description: string;
}

export interface BillPaymentInput {
  sessionId: string;
  correlation: string;
  fromAccountRef: string;
  billRef: string;
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
    store: StoreLocation;
  }): Promise<{ merchantRef: string }>;
  /** Purchases recorded at a merchant, read back from the provider. */
  listMerchantPurchases(merchantRef: string): Promise<MerchantPurchase[]>;
  /** Throws ProviderError on read failure. */
  getBalanceCents(accountRef: string): Promise<number>;
  getAccountSummary(accountRef: string): Promise<AccountSummary>;
  provisionBill(input: {
    sessionId: string;
    accountRef: string;
    payee: string;
    amountCents: number;
    dueDate: string;
  }): Promise<{ billRef: string }>;
  listBills(accountRef: string): Promise<BillRecord[]>;
  submitTransfer(input: TransferInput): Promise<SubmitOutcome>;
  submitPurchase(input: PurchaseInput): Promise<SubmitOutcome>;
  /** Mock funds arriving from outside into an account (a wallet top-up). */
  submitDeposit(input: DepositInput): Promise<SubmitOutcome>;
  /** Money leaving an account to pay one of its bills; also marks the bill paid. */
  submitBillPayment(input: BillPaymentInput): Promise<SubmitOutcome>;
  /** Idempotent: mark a bill paid after its payment record is confirmed. */
  markBillPaid(billRef: string): Promise<void>;
  /** `accountRef` is the account the record is listed on (required for withdrawals). */
  observe(kind: RecordKind, providerId: string, accountRef?: string): Promise<ObservedOutcome>;
  findByCorrelation(input: {
    kind: RecordKind;
    /** The account the record is listed on: the payer, or the receiver for deposits. */
    fromAccountRef: string;
    correlation: string;
  }): Promise<ObservedOutcome>;
}

export function operationDescription(correlation: string): string {
  return `CommonCart ${correlation}`;
}
