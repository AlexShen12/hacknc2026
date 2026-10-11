import { describe, expect, it, vi } from "vitest";
import { databaseLabel, getSponsorConfig } from "@/server/config";
import { redact } from "@/server/observability/logger";
import { NeonClient } from "@/server/providers/neon";
import {
  centsToNessieAmount,
  matchesCorrelation,
  NessieBankingProvider,
  nessieAmountToCents,
  nessieDescription,
  normalizeNessieStatus,
} from "@/server/providers/banking/nessie";

const nessieConfig = { baseUrl: "https://nessie.test", apiKey: "secret-key-123" };

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

const transfer = {
  sessionId: "s",
  correlation: "CommonCart contribution:a",
  fromAccountRef: "acct-1",
  toAccountRef: "acct-2",
  amountCents: 1500,
  description: "CommonCart contribution:a",
};

describe("Nessie amounts (observed: integers only, no balance effects)", () => {
  it("records integer cents unchanged", () => {
    for (const cents of [0, 1, 7, 1500, 6000, 10001]) {
      expect(nessieAmountToCents(centsToNessieAmount(cents))).toBe(cents);
    }
  });

  it("rejects fractional and invalid amounts instead of truncating", () => {
    expect(() => nessieAmountToCents(10.5)).toThrow();
    expect(() => nessieAmountToCents("15")).toThrow();
    expect(() => centsToNessieAmount(1.5)).toThrow();
  });

  it("never treats an unrecognized status as confirmed", () => {
    expect(normalizeNessieStatus("completed")).toBe("confirmed");
    expect(normalizeNessieStatus("cancelled")).toBe("failed");
    expect(normalizeNessieStatus("bogus")).toBe("pending");
    expect(normalizeNessieStatus(undefined)).toBe("pending");
  });

  it("puts the correlation first in descriptions", () => {
    const description = nessieDescription("CommonCart contribution:a", 1500, "acct-2");
    expect(description).toBe("CommonCart contribution:a | to:acct-2 | $15.00");
    expect(matchesCorrelation(description, "CommonCart contribution:a")).toBe(true);
    expect(matchesCorrelation(description, "CommonCart contribution:")).toBe(false);
  });
});

describe("Nessie write classification", () => {
  it("sends the observed transfer shape with the key as a query parameter", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(201, { code: 201, objectCreated: { _id: "t1", status: "completed" } }),
    );
    const provider = new NessieBankingProvider(nessieConfig, fetchImpl as unknown as typeof fetch);
    const outcome = await provider.submitTransfer(transfer);
    expect(outcome).toEqual({
      outcome: "accepted",
      providerId: "t1",
      status: "confirmed",
      providerStatus: "completed",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://nessie.test/accounts/acct-1/transfers?key=secret-key-123");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ amount: 1500, status: "completed" });
    expect(body).not.toHaveProperty("payee_id");
    expect(body).not.toHaveProperty("medium");
    expect(body.description).toContain("to:acct-2");
  });

  it.each([
    [400, "rejected"],
    [404, "rejected"],
    [429, "rejected"],
    [408, "unknown"],
    [500, "unknown"],
    [503, "unknown"],
  ])("classifies HTTP %i as %s", async (status, expected) => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(status, "validation error")) as unknown as typeof fetch);
    expect((await provider.submitTransfer(transfer)).outcome).toBe(expected);
  });

  it("keeps Nessie's validation message on rejection", async () => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(400, "1 validation error for TransferCreate")) as unknown as typeof fetch);
    expect(await provider.submitTransfer(transfer)).toMatchObject({
      message: expect.stringContaining("TransferCreate"),
    });
  });

  it("treats timeouts and missing IDs as unknown, not failed", async () => {
    const timeout = new NessieBankingProvider(nessieConfig, (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch);
    expect(await timeout.submitTransfer(transfer)).toMatchObject({
      outcome: "unknown",
      code: "NO_RESPONSE",
    });

    const missing = new NessieBankingProvider(nessieConfig, (async () =>
      respond(201, { code: 201, objectCreated: {} })) as unknown as typeof fetch);
    expect(await missing.submitTransfer(transfer)).toMatchObject({
      outcome: "unknown",
      code: "MISSING_PROVIDER_ID",
    });
  });

  it("reads transfers keyed by `id` and reports their amount", async () => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(200, { id: "t1", status: "completed", amount: 1500 })) as unknown as typeof fetch);
    expect(await provider.observe("transfer", "t1")).toEqual({
      found: true,
      providerId: "t1",
      status: "confirmed",
      providerStatus: "completed",
      amountCents: 1500,
    });
  });

  it("recovers a lost response by listing the paying account", async () => {
    const calls: string[] = [];
    const provider = new NessieBankingProvider(nessieConfig, (async (url: string) => {
      calls.push(url);
      return respond(200, [
        {
          id: "t0",
          status: "completed",
          amount: 100,
          description: "CommonCart other | to:x | $1.00",
        },
        {
          id: "t1",
          status: "completed",
          amount: 1500,
          description: nessieDescription(transfer.correlation, 1500, "acct-2"),
        },
      ]);
    }) as unknown as typeof fetch);
    expect(provider.capabilities).toMatchObject({ correlationLookup: true, balanceEffects: false });
    expect(
      await provider.findByCorrelation({
        kind: "transfer",
        fromAccountRef: "acct-1",
        correlation: transfer.correlation,
      }),
    ).toMatchObject({ found: true, providerId: "t1", status: "confirmed" });
    expect(calls[0]).toBe("https://nessie.test/accounts/acct-1/transfers?key=secret-key-123");
  });

  it("treats an empty account listing (404) as not found", async () => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(404, "No transfers found for this account")) as unknown as typeof fetch);
    expect(
      await provider.findByCorrelation({ kind: "transfer", fromAccountRef: "a", correlation: "c" }),
    ).toEqual({ found: false });
  });
});

describe("redaction", () => {
  it("removes Nessie keys, bearer tokens and account numbers", () => {
    const text = redact(
      "GET https://api/x?key=abc123&y=1 Authorization: Bearer tok.en-1 acct 1234567890123456",
    );
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("tok.en-1");
    expect(text).not.toContain("1234567890123456");
  });
});

describe("sponsor configuration", () => {
  it("fails explicitly instead of falling back to rehearsal", () => {
    expect(() =>
      getSponsorConfig({
        DATABASE_URL: "x",
        PROVIDER_MODE: "sponsor",
        DEMO_CONTROLS_ENABLED: true,
        NESSIE_BASE_URL: "https://nessie.test",
      } as Parameters<typeof getSponsorConfig>[0]),
    ).toThrow(/Missing: NESSIE_API_KEY/);
  });

  it("labels a Neon-hosted database", () => {
    const base = { PROVIDER_MODE: "rehearsal", DEMO_CONTROLS_ENABLED: true } as const;
    expect(
      databaseLabel({
        ...base,
        DATABASE_URL: "postgresql://u:p@ep-x-pooler.c-6.us-east-2.aws.neon.tech/db",
      }),
    ).toBe("Neon Postgres");
    expect(databaseLabel({ ...base, DATABASE_URL: "postgres://u:p@localhost:5432/db" })).toBe(
      "Postgres",
    );
  });
});

describe("Nessie bills and account summary (observed shapes)", () => {
  it("creates bills with the required fields and lists them in cents", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const provider = new NessieBankingProvider(nessieConfig, (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
      if (init?.method === "POST")
        return respond(201, { code: 201, objectCreated: { _id: "bill-1" } });
      return respond(200, [
        {
          _id: "bill-1",
          status: "pending",
          payee: "Duke Energy",
          payment_amount: 4200.0,
          payment_date: "2026-10-12",
          upcoming_payment_date: "2026-10-12",
        },
      ]);
    }) as unknown as typeof fetch);
    expect(
      await provider.provisionBill({
        sessionId: "s",
        accountRef: "acct-1",
        payee: "Duke Energy",
        amountCents: 4200,
        dueDate: "2026-10-12",
      }),
    ).toEqual({ billRef: "bill-1" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      status: "pending",
      payee: "Duke Energy",
      payment_amount: 4200,
      payment_date: "2026-10-12",
      recurring_date: 12,
    });
    expect(await provider.listBills("acct-1")).toEqual([
      {
        id: "bill-1",
        payee: "Duke Energy",
        amountCents: 4200,
        dueDate: "2026-10-12",
        status: "pending",
      },
    ]);
  });

  it("masks the account number to its last four digits", async () => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(200, {
        _id: "a",
        balance: 10000,
        nickname: "Alex checking",
        account_number: "1713235014524836",
      })) as unknown as typeof fetch);
    expect(await provider.getAccountSummary("a")).toEqual({
      balanceCents: 10000,
      nickname: "Alex checking",
      maskedNumber: "•••• 4836",
    });
  });
});

describe("Nessie deposits, bill payments and merchants (observed shapes)", () => {
  it("records a deposit on the receiving account", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const provider = new NessieBankingProvider(nessieConfig, (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
      return respond(201, { code: 201, objectCreated: { _id: "d1", status: "completed" } });
    }) as unknown as typeof fetch);
    const outcome = await provider.submitDeposit({
      sessionId: "s",
      correlation: "CommonCart deposit:k",
      toAccountRef: "acct-1",
      amountCents: 2500,
      description: "CommonCart deposit:k",
    });
    expect(outcome).toMatchObject({ outcome: "accepted", providerId: "d1", status: "confirmed" });
    expect(calls[0]?.url).toBe("https://nessie.test/accounts/acct-1/deposits?key=secret-key-123");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      medium: "balance",
      status: "completed",
      amount: 2500,
    });
  });

  it("pays a bill with a withdrawal record, then marks the bill paid", async () => {
    const calls: string[] = [];
    const provider = new NessieBankingProvider(nessieConfig, (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push(`${init?.method} ${url.split("?")[0]} ${init?.body ?? ""}`);
      if (init?.method === "PUT") return respond(202, { code: 202, objectUpdated: {} });
      return respond(201, { code: 201, objectCreated: { _id: "w1", status: "completed" } });
    }) as unknown as typeof fetch);
    const outcome = await provider.submitBillPayment({
      sessionId: "s",
      correlation: "CommonCart bill_payment:b1",
      fromAccountRef: "acct-1",
      billRef: "b1",
      amountCents: 4200,
      description: "CommonCart bill_payment:b1",
    });
    expect(outcome).toMatchObject({ outcome: "accepted", providerId: "w1" });
    expect(calls[0]).toContain("POST https://nessie.test/accounts/acct-1/withdrawals");
    expect(calls[1]).toBe('PUT https://nessie.test/bills/b1 {"status":"completed"}');
  });

  it("reads withdrawals through the account listing (GET /withdrawals/{id} is not served)", async () => {
    const urls: string[] = [];
    const provider = new NessieBankingProvider(nessieConfig, (async (url: string) => {
      urls.push(url.split("?")[0] ?? "");
      return respond(200, [{ _id: "w1", status: "completed", amount: 4200, description: "x" }]);
    }) as unknown as typeof fetch);
    expect(await provider.observe("withdrawal", "w1", "acct-1")).toMatchObject({
      found: true,
      status: "confirmed",
      amountCents: 4200,
    });
    expect(urls).toEqual(["https://nessie.test/accounts/acct-1/withdrawals"]);
  });

  it("lists purchases recorded at a merchant", async () => {
    const provider = new NessieBankingProvider(nessieConfig, (async () =>
      respond(200, [
        {
          _id: "p1",
          amount: 6000,
          status: "completed",
          purchase_date: "2026-10-11",
          merchant_id: "m",
        },
      ])) as unknown as typeof fetch);
    expect(await provider.listMerchantPurchases("m")).toEqual([
      { id: "p1", amountCents: 6000, status: "completed", date: "2026-10-11" },
    ]);
  });
});

describe("Neon API client", () => {
  const neonConfig = { apiKey: "napi_secret", projectId: "proj-1" };

  it("finds the branch behind a pooled host and creates a compute-free branch", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new NeonClient(neonConfig, (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/endpoints")) {
        return respond(200, {
          endpoints: [{ id: "ep-empty-water-b4mbiooy", host: "h", branch_id: "br-main" }],
        });
      }
      return respond(201, {
        branch: {
          id: "br-snap",
          name: "commoncart-snapshot-x",
          parent_id: "br-main",
          created_at: "2026-10-11T00:00:00Z",
        },
      });
    }) as unknown as typeof fetch);
    expect(
      await client.branchForHost("ep-empty-water-b4mbiooy-pooler.c-6.us-east-2.aws.neon.tech"),
    ).toBe("br-main");
    const branch = await client.createBranch("commoncart-snapshot-x", "br-main");
    expect(branch.id).toBe("br-snap");
    expect(calls[1]?.url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      branch: { name: "commoncart-snapshot-x", parent_id: "br-main" },
    });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer napi_secret",
    );
  });

  it("surfaces Neon's error message", async () => {
    const client = new NeonClient(neonConfig, (async () =>
      respond(422, { message: "branches limit exceeded" })) as unknown as typeof fetch);
    await expect(client.createBranch("x", "br")).rejects.toThrow(/branches limit exceeded/);
  });
});
