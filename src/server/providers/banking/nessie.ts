import { z } from "zod";
import type { Retailer } from "@/domain/types";
import type { NessieConfig } from "@/server/config";
import { log, redact } from "@/server/observability/logger";
import type {
  BankingProvider,
  ObservedOutcome,
  PurchaseInput,
  SubmitOutcome,
  TransferInput,
} from "@/server/providers/banking/types";
import { PROVIDER_TIMEOUT_MS, ProviderError, withRetries } from "@/server/providers/errors";

/**
 * Paths from the public Nessie documentation (see techContext.md). UNVERIFIED until
 * `npm run verify:sponsors` records authenticated evidence; keep every path in this table.
 */
export const NESSIE_PATHS = {
  customers: () => "/customers",
  customerAccounts: (customerId: string) => `/customers/${encodeURIComponent(customerId)}/accounts`,
  account: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`,
  accountTransfers: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/transfers`,
  transfer: (transferId: string) => `/transfers/${encodeURIComponent(transferId)}`,
  merchants: () => "/merchants",
  accountPurchases: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/purchases`,
  purchase: (purchaseId: string) => `/purchase/${encodeURIComponent(purchaseId)}`,
};

/**
 * ASSUMPTION (unverified): Nessie amounts are decimal dollars. All conversion lives here.
 */
export function centsToNessieAmount(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cents");
  return cents / 100;
}

export function nessieAmountToCents(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new ProviderError("nessie", "Invalid amount in Nessie response");
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) {
    throw new ProviderError("nessie", "Nessie amount has sub-cent precision");
  }
  return cents;
}

/** Map documented transaction statuses; anything unrecognized stays unresolved, never confirmed. */
export function normalizeNessieStatus(status: unknown): "pending" | "confirmed" | "failed" {
  const value = typeof status === "string" ? status.toLowerCase() : "";
  if (value === "executed" || value === "completed") return "confirmed";
  if (value === "cancelled" || value === "canceled" || value === "failed") return "failed";
  return "pending";
}

const createdSchema = z.object({
  objectCreated: z.looseObject({ _id: z.string().min(1), status: z.string().optional() }),
});
const transactionSchema = z.looseObject({ _id: z.string().min(1), status: z.string().optional() });
const accountSchema = z.looseObject({ _id: z.string(), balance: z.number() });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class NessieBankingProvider implements BankingProvider {
  readonly name = "nessie" as const;
  readonly capabilities = {
    correlationLookup: false,
    amountUnit: "decimal dollars (assumed; unverified)",
    verified: false,
  };

  constructor(
    private readonly config: NessieConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.baseUrl}${path}?key=${encodeURIComponent(this.config.apiKey)}`;
  }

  private async request(
    method: "GET" | "POST",
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
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let result: { status: number; json: unknown };
    try {
      result = await this.request(method, path, body);
    } catch (error) {
      throw new ProviderError("nessie", `Nessie request failed: ${redact(String(error))}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new ProviderError("nessie", `Nessie returned HTTP ${result.status}`, result.status);
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

  async provisionMerchant(input: { sessionId: string; retailer: Retailer; name: string }) {
    const merchantRef = await this.createObject(NESSIE_PATHS.merchants(), {
      name: `${input.name} (demo)`,
      category: ["grocery"],
      address: {
        street_number: "100",
        street_name: "Franklin St",
        city: "Chapel Hill",
        state: "NC",
        zip: "27514",
      },
      geocode: { lat: 35.9132, lng: -79.0558 },
    });
    return { merchantRef };
  }

  async getBalanceCents(accountRef: string): Promise<number> {
    const json = await withRetries(() => this.call("GET", NESSIE_PATHS.account(accountRef)));
    const parsed = accountSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected account response");
    return nessieAmountToCents(parsed.data.balance);
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
    return {
      outcome: "rejected",
      code: result.status === 429 ? "RATE_LIMITED" : "PROVIDER_REJECTED",
      message: `HTTP ${result.status}`,
      httpStatus: result.status,
    };
  }

  submitTransfer(input: TransferInput): Promise<SubmitOutcome> {
    return this.write(NESSIE_PATHS.accountTransfers(input.fromAccountRef), {
      medium: "balance",
      payee_id: input.toAccountRef,
      amount: centsToNessieAmount(input.amountCents),
      transaction_date: today(),
      description: input.description,
    });
  }

  submitPurchase(input: PurchaseInput): Promise<SubmitOutcome> {
    return this.write(NESSIE_PATHS.accountPurchases(input.fromAccountRef), {
      merchant_id: input.merchantRef,
      medium: "balance",
      purchase_date: today(),
      amount: centsToNessieAmount(input.amountCents),
      description: input.description,
    });
  }

  async observe(kind: "transfer" | "purchase", providerId: string): Promise<ObservedOutcome> {
    const path =
      kind === "transfer" ? NESSIE_PATHS.transfer(providerId) : NESSIE_PATHS.purchase(providerId);
    let json: unknown;
    try {
      json = await withRetries(() => this.call("GET", path));
    } catch (error) {
      if (error instanceof ProviderError && error.httpStatus === 404) return { found: false };
      throw error;
    }
    const parsed = transactionSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("nessie", "Unexpected transaction response");
    const providerStatus = parsed.data.status ?? "unknown";
    return {
      found: true,
      providerId: parsed.data._id,
      status: normalizeNessieStatus(providerStatus),
      providerStatus,
    };
  }

  /** Not verified for Nessie; unknown writes without an ID stay unresolved for the operator. */
  async findByCorrelation(): Promise<ObservedOutcome> {
    return { found: false };
  }
}
