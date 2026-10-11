import { z } from "zod";
import type { Retailer } from "@/domain/types";
import type { NessieConfig } from "@/server/config";
import { log, redact } from "@/server/observability/logger";
import type {
  BankingProvider,
  BillPaymentInput,
  DepositInput,
  ObservedOutcome,
  PurchaseInput,
  RecordKind,
  StoreLocation,
  SubmitOutcome,
  TransferInput,
} from "@/server/providers/banking/types";
import { PROVIDER_TIMEOUT_MS, ProviderError, withRetries } from "@/server/providers/errors";

/**
 * Paths observed working against prod-api.nessieisreal.com on 2026-10-10 (see techContext.md).
 * Note the singular `/purchase/{id}` read path; the plural form returns 403.
 */
export const NESSIE_PATHS = {
  customers: () => "/customers",
  customerAccounts: (customerId: string) => `/customers/${encodeURIComponent(customerId)}/accounts`,
  account: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`,
  accountTransfers: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/transfers`,
  transfer: (transferId: string) => `/transfers/${encodeURIComponent(transferId)}`,
  merchants: () => "/merchants",
  accountPurchases: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/purchases`,
  accountBills: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/bills`,
  accountDeposits: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/deposits`,
  // Observed: withdrawals are listed per account, but GET /withdrawals/{id} returns 403.
  accountWithdrawals: (accountId: string) =>
    `/accounts/${encodeURIComponent(accountId)}/withdrawals`,
  purchase: (purchaseId: string) => `/purchase/${encodeURIComponent(purchaseId)}`,
  deposit: (depositId: string) => `/deposits/${encodeURIComponent(depositId)}`,
  bill: (billId: string) => `/bills/${encodeURIComponent(billId)}`,
  merchant: (merchantId: string) => `/merchants/${encodeURIComponent(merchantId)}`,
  merchantPurchases: (merchantId: string) =>
    `/merchants/${encodeURIComponent(merchantId)}/purchases`,
};

/** Where each record kind is listed for an account (for correlation lookup and withdrawals). */
const LIST_PATH: Record<RecordKind, (accountId: string) => string> = {
  transfer: NESSIE_PATHS.accountTransfers,
  purchase: NESSIE_PATHS.accountPurchases,
  deposit: NESSIE_PATHS.accountDeposits,
  withdrawal: NESSIE_PATHS.accountWithdrawals,
};

/**
 * Observed 2026-10-10: Nessie stores integer amounts (10.5 was stored as 10) and applies no balance
 * effects, so the unit is CommonCart's convention. We record integer cents so every share is exact,
 * and put the formatted dollar amount in each description for readability.
 */
export function centsToNessieAmount(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cents");
  return cents;
}

export function nessieAmountToCents(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ProviderError("nessie", "Invalid amount in Nessie response");
  }
  return amount;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Description stored with each record: correlation first, so lookups can match its prefix. */
export function nessieDescription(correlation: string, amountCents: number, toRef: string): string {
  return `${correlation} | to:${toRef} | ${dollars.format(amountCents / 100)}`;
}

export function matchesCorrelation(description: unknown, correlation: string): boolean {
  return (
    typeof description === "string" &&
    (description === correlation || description.startsWith(`${correlation} | `))
  );
}

/**
 * Map statuses; anything unrecognized stays unresolved, never confirmed. Observed: Nessie stores
 * whatever status the client sends (it does not validate or advance it).
 */
export function normalizeNessieStatus(status: unknown): "pending" | "confirmed" | "failed" {
  const value = typeof status === "string" ? status.toLowerCase() : "";
  if (value === "executed" || value === "completed") return "confirmed";
  if (value === "cancelled" || value === "canceled" || value === "failed") return "failed";
  return "pending";
}

const createdSchema = z.object({
  objectCreated: z.looseObject({ _id: z.string().min(1), status: z.string().optional() }),
});
// GET /transfers/{id} returns `id`; GET /purchase/{id} and list endpoints return `_id`.
const transactionSchema = z
  .looseObject({
    _id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    status: z.string().optional(),
    amount: z.number().optional(),
    description: z.string().optional(),
  })
  .refine((value) => value._id ?? value.id, { message: "missing id" });
const accountSchema = z.looseObject({
  _id: z.string(),
  balance: z.number(),
  nickname: z.string().optional(),
  account_number: z.string().optional(),
});
// Observed 2026-10-10: status, payee and payment_amount are required; reads include
// upcoming_payment_date. An account without bills lists as [].
const billSchema = z.looseObject({
  _id: z.string(),
  status: z.string(),
  payee: z.string(),
  payment_amount: z.number(),
  payment_date: z.string().optional(),
  upcoming_payment_date: z.string().optional(),
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class NessieBankingProvider implements BankingProvider {
  readonly name = "nessie" as const;
  readonly capabilities = {
    correlationLookup: true,
    // A record can be found by listing, but its absence is not proof it was never stored.
    correlationAbsenceIsProof: false,
    amountUnit: "integer cents (CommonCart convention; Nessie stores integers only)",
    verified: true,
    balanceEffects: false,
  };

  constructor(
    private readonly config: NessieConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.baseUrl}${path}?key=${encodeURIComponent(this.config.apiKey)}`;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const started = Date.now();
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const text = await response.text();
    log("info", "nessie.request", {
      method,
      path: redact(path),
      status: response.status,
      durationMs: Date.now() - started,
    });
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** Reads and setup writes throw ProviderError; setup has no money at stake. */
  private async call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let result: { status: number; json: unknown };
    try {
      result = await this.request(method, path, body);
    } catch (error) {
      throw new ProviderError("nessie", `Nessie request failed: ${redact(String(error))}`);
    }
    if (result.status < 200 || result.status >= 300) {
      const detail =
        typeof result.json === "string" ? `: ${redact(result.json).slice(0, 200)}` : "";
      throw new ProviderError(
        "nessie",
        `Nessie returned HTTP ${result.status} for ${method} ${path.split("/")[1] ?? ""}${detail}`,
        result.status,
      );
    }
    return result.json;
  }

  private async createObject(path: string, body: unknown): Promise<string> {
    const parsed = createdSchema.safeParse(await this.call("POST", path, body));
    if (!parsed.success) throw new ProviderError("nessie", "Nessie create response had no _id");
    return parsed.data.objectCreated._id;
  }

  async provisionShopper(input: {
    sessionId: string;
    displayName: string;
    openingBalanceCents: number;
  }) {
    const customerRef = await this.createObject(NESSIE_PATHS.customers(), {
      first_name: input.displayName,
      last_name: `Demo ${input.sessionId.slice(-6)}`,
      address: {
        street_number: "100",
        street_name: "Franklin St",
        city: "Chapel Hill",
        state: "NC",
        zip: "27514",
      },
    });
    const accountRef = await this.createObject(NESSIE_PATHS.customerAccounts(customerRef), {
      type: "Checking",
      nickname: `${input.displayName} CommonCart demo`,
      rewards: 0,
      balance: centsToNessieAmount(input.openingBalanceCents),
    });
    return { customerRef, accountRef };
  }

  async provisionCollectionCustomer(input: { sessionId: string }) {
    const customerRef = await this.createObject(NESSIE_PATHS.customers(), {
      first_name: "CommonCart",
      last_name: `Collections ${input.sessionId.slice(-6)}`,
      address: {
        street_number: "100",
        street_name: "Franklin St",
        city: "Chapel Hill",
        state: "NC",
        zip: "27514",
      },
    });
    return { customerRef };
  }

  async provisionCollectionAccount(input: {
    sessionId: string;
    groupId: string;
    customerRef: string | null;
  }) {
    if (!input.customerRef) throw new ProviderError("nessie", "Collection customer missing");
    const accountRef = await this.createObject(NESSIE_PATHS.customerAccounts(input.customerRef), {
      type: "Savings",
      nickname: `Group ${input.groupId.slice(-8)} collection`,
      rewards: 0,
      balance: 0,
    });
    return { accountRef };
  }

  /** Each retailer's pickup store is a Nessie merchant with its address and map location. */
  async provisionMerchant(input: { sessionId: string; retailer: Retailer; store: StoreLocation }) {
    const { address, geocode } = input.store;
    const merchantRef = await this.createObject(NESSIE_PATHS.merchants(), {
      name: input.store.name,
      category: "grocery",
      address: {
        street_number: address.streetNumber,
        street_name: address.streetName,
        city: address.city,
        state: address.state,
        zip: address.zip,
      },
      geocode: { lat: geocode.lat, lng: geocode.lng },
    });
    return { merchantRef };
  }

  /** Observed 2026-10-11: GET /merchants/{id}/purchases lists every purchase at the merchant. */
  async listMerchantPurchases(merchantRef: string) {
    const json = await withRetries(() =>
      this.call("GET", NESSIE_PATHS.merchantPurchases(merchantRef)),
    );
    const parsed = z.array(transactionSchema).safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected merchant purchases response");
    return parsed.data.map((row) => ({
      id: row._id ?? row.id ?? "",
      amountCents: nessieAmountToCents(row.amount ?? 0),
      status: row.status ?? "unknown",
      date: String((row as { purchase_date?: unknown }).purchase_date ?? ""),
    }));
  }

  async getBalanceCents(accountRef: string): Promise<number> {
    const json = await withRetries(() => this.call("GET", NESSIE_PATHS.account(accountRef)));
    const parsed = accountSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected account response");
    return nessieAmountToCents(parsed.data.balance);
  }

  async getAccountSummary(accountRef: string) {
    const json = await withRetries(() => this.call("GET", NESSIE_PATHS.account(accountRef)));
    const parsed = accountSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected account response");
    const number = parsed.data.account_number;
    return {
      balanceCents: nessieAmountToCents(parsed.data.balance),
      nickname: parsed.data.nickname ?? "Checking",
      maskedNumber: number && number.length >= 4 ? `•••• ${number.slice(-4)}` : null,
    };
  }

  async provisionBill(input: {
    sessionId: string;
    accountRef: string;
    payee: string;
    amountCents: number;
    dueDate: string;
  }) {
    const billRef = await this.createObject(NESSIE_PATHS.accountBills(input.accountRef), {
      status: "pending",
      payee: input.payee,
      nickname: input.payee,
      payment_date: input.dueDate,
      // Observed: without recurring_date the bill is accepted but GET /accounts/{id}/bills then
      // fails for the whole account ("validation errors for Bill"), so always send it.
      recurring_date: Number(input.dueDate.slice(8, 10)),
      payment_amount: centsToNessieAmount(input.amountCents),
    });
    return { billRef };
  }

  async listBills(accountRef: string) {
    const json = await withRetries(() => this.call("GET", NESSIE_PATHS.accountBills(accountRef)));
    const parsed = z.array(billSchema).safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected bills response");
    return parsed.data.map((bill) => ({
      id: bill._id,
      payee: bill.payee,
      // Bills we create use the integer-cents convention; round any foreign fractional amount up.
      amountCents: Math.ceil(bill.payment_amount),
      // Observed: upcoming_payment_date rolls a bill due "today" (UTC) to next month, so the
      // payment_date we set is the reliable due date for one-off bills.
      dueDate: bill.payment_date ?? bill.upcoming_payment_date ?? "",
      status: bill.status,
    }));
  }

  /**
   * Classify a money-moving write. A thrown fetch (timeout, reset) may have reached Nessie, so it
   * is unknown. 4xx other than 408 is a definite rejection; 5xx/408 are unknown.
   */
  private async write(path: string, body: unknown): Promise<SubmitOutcome> {
    let result: { status: number; json: unknown };
    try {
      result = await this.request("POST", path, body);
    } catch (error) {
      return { outcome: "unknown", code: "NO_RESPONSE", message: redact(String(error)) };
    }
    if (result.status >= 200 && result.status < 300) {
      const parsed = createdSchema.safeParse(result.json);
      if (!parsed.success) {
        return { outcome: "unknown", code: "MISSING_PROVIDER_ID", message: "No _id in response" };
      }
      const providerStatus = parsed.data.objectCreated.status ?? "pending";
      const status = normalizeNessieStatus(providerStatus);
      if (status === "failed") {
        return { outcome: "rejected", code: "PROVIDER_CANCELLED", message: providerStatus };
      }
      return {
        outcome: "accepted",
        providerId: parsed.data.objectCreated._id,
        status,
        providerStatus,
      };
    }
    if (result.status === 408 || result.status >= 500) {
      return {
        outcome: "unknown",
        code: "UPSTREAM_ERROR",
        message: `HTTP ${result.status}`,
        httpStatus: result.status,
      };
    }
    const detail = typeof result.json === "string" ? `: ${redact(result.json).slice(0, 200)}` : "";
    return {
      outcome: "rejected",
      code: result.status === 429 ? "RATE_LIMITED" : "PROVIDER_REJECTED",
      message: `HTTP ${result.status}${detail}`,
      httpStatus: result.status,
    };
  }

  /**
   * Observed: transfers accept only status/amount/transaction_date/description (no payee field), so
   * the destination account is recorded in the description. `status` is required and stored as sent.
   */
  submitTransfer(input: TransferInput): Promise<SubmitOutcome> {
    return this.write(NESSIE_PATHS.accountTransfers(input.fromAccountRef), {
      status: "completed",
      amount: centsToNessieAmount(input.amountCents),
      transaction_date: today(),
      description: nessieDescription(input.correlation, input.amountCents, input.toAccountRef),
    });
  }

  submitPurchase(input: PurchaseInput): Promise<SubmitOutcome> {
    return this.write(NESSIE_PATHS.accountPurchases(input.fromAccountRef), {
      merchant_id: input.merchantRef,
      medium: "balance",
      purchase_date: today(),
      status: "completed",
      amount: centsToNessieAmount(input.amountCents),
      description: nessieDescription(input.correlation, input.amountCents, input.merchantRef),
    });
  }

  /** Observed 2026-10-11: deposits record money in; status is stored as sent. */
  submitDeposit(input: DepositInput): Promise<SubmitOutcome> {
    return this.write(NESSIE_PATHS.accountDeposits(input.toAccountRef), {
      medium: "balance",
      transaction_date: today(),
      status: "completed",
      amount: centsToNessieAmount(input.amountCents),
      description: nessieDescription(input.correlation, input.amountCents, input.toAccountRef),
    });
  }

  /**
   * A bill payment is a withdrawal record (the money) plus a bill status update. The status update
   * is idempotent and retried by reconciliation, so a failure there never repeats the withdrawal.
   */
  async submitBillPayment(input: BillPaymentInput): Promise<SubmitOutcome> {
    const outcome = await this.write(NESSIE_PATHS.accountWithdrawals(input.fromAccountRef), {
      medium: "balance",
      transaction_date: today(),
      status: "completed",
      amount: centsToNessieAmount(input.amountCents),
      description: nessieDescription(input.correlation, input.amountCents, `bill:${input.billRef}`),
    });
    if (outcome.outcome === "accepted") {
      await this.markBillPaid(input.billRef).catch(() => undefined);
    }
    return outcome;
  }

  /** Observed 2026-10-11: PUT /bills/{id} with a status returns 202; an empty body returns 404. */
  async markBillPaid(billRef: string): Promise<void> {
    await withRetries(() => this.call("PUT", NESSIE_PATHS.bill(billRef), { status: "completed" }));
  }

  async observe(kind: RecordKind, providerId: string, accountRef?: string): Promise<ObservedOutcome> {
    if (kind === "withdrawal") {
      if (!accountRef) throw new ProviderError("nessie", "Withdrawals are read through their account");
      return this.findInList(LIST_PATH.withdrawal(accountRef), (item) => item._id === providerId);
    }
    const path =
      kind === "transfer"
        ? NESSIE_PATHS.transfer(providerId)
        : kind === "deposit"
          ? NESSIE_PATHS.deposit(providerId)
          : NESSIE_PATHS.purchase(providerId);
    let json: unknown;
    try {
      json = await withRetries(() => this.call("GET", path));
    } catch (error) {
      if (error instanceof ProviderError && error.httpStatus === 404) return { found: false };
      throw error;
    }
    return toObserved(json);
  }

  /**
   * Verified 2026-10-10: transfers and purchases are listed per paying account and keep the
   * description we send, so a lost response can be recovered by its correlation prefix. A 404
   * list response means the account has no records of that kind.
   */
  async findByCorrelation(input: {
    kind: RecordKind;
    fromAccountRef: string;
    correlation: string;
  }): Promise<ObservedOutcome> {
    return this.findInList(LIST_PATH[input.kind](input.fromAccountRef), (item) =>
      matchesCorrelation(item.description, input.correlation),
    );
  }

  /** Read an account listing; a 404 means the account has no records of that kind. */
  private async findInList(
    path: string,
    predicate: (item: { _id?: unknown; description?: unknown }) => boolean,
  ): Promise<ObservedOutcome> {
    let json: unknown;
    try {
      json = await withRetries(() => this.call("GET", path));
    } catch (error) {
      if (error instanceof ProviderError && error.httpStatus === 404) return { found: false };
      throw error;
    }
    if (!Array.isArray(json)) throw new ProviderError("nessie", "Unexpected list response");
    const match = json.find((item) => predicate(item as { _id?: unknown; description?: unknown }));
    return match ? toObserved(match) : { found: false };
  }
}

function toObserved(json: unknown): ObservedOutcome {
  const parsed = transactionSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("nessie", "Unexpected transaction response");
  const providerStatus = parsed.data.status ?? "unknown";
  return {
    found: true,
    providerId: parsed.data._id ?? parsed.data.id ?? "",
    status: normalizeNessieStatus(providerStatus),
    providerStatus,
    amountCents:
      parsed.data.amount === undefined ? undefined : nessieAmountToCents(parsed.data.amount),
  };
}
