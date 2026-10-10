import { describe, expect, it, vi } from "vitest";
import { getSponsorConfig } from "@/server/config";
import { redact } from "@/server/observability/logger";
import {
  SnowflakeAnalyticsProvider,
  SnowflakeSqlClient,
} from "@/server/providers/analytics/snowflake";
import {
  centsToNessieAmount,
  NessieBankingProvider,
  nessieAmountToCents,
  normalizeNessieStatus,
} from "@/server/providers/banking/nessie";
import { mergeStatement, TABLES } from "../../snowflake/queries";

const nessieConfig = { baseUrl: "https://nessie.test", apiKey: "secret-key-123" };
const snowflakeConfig = {
  accountUrl: "https://acct.snowflakecomputing.com",
  pat: "pat-token",
  role: "DEMO_ROLE",
  warehouse: "DEMO_WH",
  database: "COMMONCART",
  schema: "DEMO",
  model: "claude-haiku-4-5",
};

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

describe("Nessie amount conversion (assumed dollars)", () => {
  it("round-trips cents", () => {
    for (const cents of [0, 1, 7, 1500, 6000, 10001]) {
      expect(nessieAmountToCents(centsToNessieAmount(cents))).toBe(cents);
    }
  });

  it("rejects sub-cent and invalid amounts", () => {
    expect(() => nessieAmountToCents(15.005)).toThrow();
    expect(() => nessieAmountToCents("15")).toThrow();
    expect(() => centsToNessieAmount(1.5)).toThrow();
  });

  it("never treats an unrecognized status as confirmed", () => {
    expect(normalizeNessieStatus("executed")).toBe("confirmed");
    expect(normalizeNessieStatus("cancelled")).toBe("failed");
    expect(normalizeNessieStatus("processing")).toBe("pending");
    expect(normalizeNessieStatus(undefined)).toBe("pending");
  });
});

describe("Nessie write classification", () => {
  it("sends dollars and the key as a query parameter", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(201, { code: 201, objectCreated: { _id: "t1", status: "pending" } }),
    );
    const provider = new NessieBankingProvider(nessieConfig, fetchImpl as unknown as typeof fetch);
    const outcome = await provider.submitTransfer(transfer);
    expect(outcome).toEqual({
      outcome: "accepted",
      providerId: "t1",
      status: "pending",
      providerStatus: "pending",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://nessie.test/accounts/acct-1/transfers?key=secret-key-123");
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: 15,
      payee_id: "acct-2",
      medium: "balance",
    });
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
      respond(status, { message: "x" })) as unknown as typeof fetch);
    expect((await provider.submitTransfer(transfer)).outcome).toBe(expected);
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

  it("does not claim a correlation lookup", async () => {
    const provider = new NessieBankingProvider(nessieConfig, vi.fn() as unknown as typeof fetch);
    expect(provider.capabilities.correlationLookup).toBe(false);
    expect(await provider.findByCorrelation()).toEqual({ found: false });
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

describe("Snowflake SQL API", () => {
  it("binds values positionally and follows async statement handles", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      respond(202, { statementHandle: "h1", statementStatusUrl: "/api/v2/statements/h1" }),
      respond(200, {
        statementHandle: "h1",
        resultSetMetaData: {
          rowType: [{ name: "NEED_ID" }, { name: "SHOPPER_ID" }, { name: "ENTITY_VERSION" }],
        },
        data: [["n1", "s1", "2"]],
      }),
    ];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift() ?? respond(500, {});
    }) as unknown as typeof fetch;
    const provider = new SnowflakeAnalyticsProvider(snowflakeConfig, fetchImpl);
    const result = await provider.queryCandidates({
      sessionId: "ses_1",
      offerId: "off_1",
      initiatingNeedId: "need_1",
      initiatingShopperId: "shp_1",
      pickupZone: "zone",
      pickupWindow: "window-a",
      limit: 11,
    });
    expect(result).toEqual({
      rows: [{ needId: "n1", shopperId: "s1", entityVersion: 2 }],
      queryId: "h1",
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.statement).not.toContain("ses_1");
    expect(body.bindings["1"]).toEqual({ type: "TEXT", value: "ses_1" });
    expect(body.bindings["7"]).toEqual({ type: "FIXED", value: "11" });
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer pat-token",
    );
    expect(calls[1]?.url).toBe("https://acct.snowflakecomputing.com/api/v2/statements/h1");
  });

  it("surfaces HTTP failures as retryable provider errors", async () => {
    const client = new SnowflakeSqlClient(snowflakeConfig, (async () =>
      respond(403, {})) as unknown as typeof fetch);
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("builds version-guarded MERGE statements without interpolated values", () => {
    const { sql, columnOrder } = mergeStatement(TABLES.need);
    expect(sql).toContain("WHEN MATCHED AND s.ENTITY_VERSION > t.ENTITY_VERSION");
    expect(sql.match(/\?/g)).toHaveLength(columnOrder.length);
  });

  it("returns Cortex text for validation by the caller", async () => {
    const provider = new SnowflakeAnalyticsProvider(snowflakeConfig, (async () =>
      respond(200, {
        id: "req-1",
        choices: [{ message: { content: "Everyone saves $7.00." } }],
      })) as unknown as typeof fetch);
    const result = await provider.explain({
      groupId: "g",
      proposalVersion: 1,
      productName: "Paper Towels",
      retailerLabel: "Walmart",
      unit: "rolls",
      packageQuantity: 24,
      totalCents: 6000,
      taxCents: 0,
      feeCents: 0,
      pickupLabel: "Sat",
      sourceLabel: "fixture",
      members: [],
      totalSavingsCents: 2800,
      excluded: [],
    });
    expect(result).toEqual({ text: "Everyone saves $7.00.", requestId: "req-1" });
  });
});

describe("sponsor configuration", () => {
  it("fails explicitly instead of falling back to rehearsal", () => {
    expect(() =>
      getSponsorConfig({
        DATABASE_URL: "x",
        PROVIDER_MODE: "sponsor",
        DEMO_CONTROLS_ENABLED: true,
        NESSIE_API_KEY: "k",
      } as Parameters<typeof getSponsorConfig>[0]),
    ).toThrow(/Sponsor mode is not configured/);
  });
});
