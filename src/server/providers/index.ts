import type { ProviderMode } from "@/domain/types";
import { getSponsorConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { LocalAnalyticsProvider } from "@/server/providers/analytics/local";
import { SnowflakeAnalyticsProvider } from "@/server/providers/analytics/snowflake";
import type { AnalyticsProvider } from "@/server/providers/analytics/types";
import { NessieBankingProvider } from "@/server/providers/banking/nessie";
import { RehearsalBankingProvider } from "@/server/providers/banking/rehearsal";
import type { BankingProvider } from "@/server/providers/banking/types";
import { FixtureRetailProvider } from "@/server/providers/retail/fixtures";
import type { RetailProvider } from "@/server/providers/retail/types";

export interface Providers {
  mode: ProviderMode;
  banking: BankingProvider;
  analytics: AnalyticsProvider;
  retail: RetailProvider;
}

type Factory = (mode: ProviderMode) => Providers;

const defaultFactory: Factory = (mode) => {
  if (mode === "sponsor") {
    // Throws SPONSOR_NOT_CONFIGURED; a sponsor session never falls back to rehearsal providers.
    const config = getSponsorConfig();
    return {
      mode,
      banking: new NessieBankingProvider(config.nessie),
      analytics: new SnowflakeAnalyticsProvider(config.snowflake),
      retail: new FixtureRetailProvider(),
    };
  }
  const db = getDb();
  return {
    mode,
    banking: new RehearsalBankingProvider(db),
    analytics: new LocalAnalyticsProvider(db),
    retail: new FixtureRetailProvider(),
  };
};

let factory: Factory = defaultFactory;

/** Providers are chosen from the session's persisted mode, never from current env defaults. */
export function providersFor(mode: ProviderMode): Providers {
  return factory(mode);
}

/** Test hook for adapter fakes. */
export function setProviderFactory(next: Factory | null): void {
  factory = next ?? defaultFactory;
}
