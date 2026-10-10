import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { PROVIDER_MODES } from "@/domain/types";

const optional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_ORIGIN: optional,
  PROVIDER_MODE: z.enum(PROVIDER_MODES).default("rehearsal"),
  DEMO_CONTROLS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  NESSIE_BASE_URL: optional,
  NESSIE_API_KEY: optional,
  SNOWFLAKE_ACCOUNT_URL: optional,
  SNOWFLAKE_PAT: optional,
  SNOWFLAKE_ROLE: optional,
  SNOWFLAKE_WAREHOUSE: optional,
  SNOWFLAKE_DATABASE: optional,
  SNOWFLAKE_SCHEMA: optional,
  SNOWFLAKE_MODEL: optional,
});

export type AppConfig = z.infer<typeof envSchema>;

export function getConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server configuration: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export interface NessieConfig {
  baseUrl: string;
  apiKey: string;
}

export interface SnowflakeConfig {
  accountUrl: string;
  pat: string;
  role: string;
  warehouse: string;
  database: string;
  schema: string;
  model: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;

/** Sponsor sessions require every credential; a missing value never downgrades to rehearsal. */
export function getSponsorConfig(config = getConfig()): {
  nessie: NessieConfig;
  snowflake: SnowflakeConfig;
} {
  const required = {
    NESSIE_BASE_URL: config.NESSIE_BASE_URL,
    NESSIE_API_KEY: config.NESSIE_API_KEY,
    SNOWFLAKE_ACCOUNT_URL: config.SNOWFLAKE_ACCOUNT_URL,
    SNOWFLAKE_PAT: config.SNOWFLAKE_PAT,
    SNOWFLAKE_ROLE: config.SNOWFLAKE_ROLE,
    SNOWFLAKE_WAREHOUSE: config.SNOWFLAKE_WAREHOUSE,
    SNOWFLAKE_DATABASE: config.SNOWFLAKE_DATABASE,
    SNOWFLAKE_SCHEMA: config.SNOWFLAKE_SCHEMA,
    SNOWFLAKE_MODEL: config.SNOWFLAKE_MODEL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new DomainError(
      "SPONSOR_NOT_CONFIGURED",
      `Sponsor mode is not configured. Missing: ${missing.join(", ")}.`,
      { missing },
    );
  }
  for (const key of [
    "SNOWFLAKE_ROLE",
    "SNOWFLAKE_WAREHOUSE",
    "SNOWFLAKE_DATABASE",
    "SNOWFLAKE_SCHEMA",
  ] as const) {
    if (!IDENTIFIER.test(required[key] ?? "")) {
      throw new DomainError("SPONSOR_NOT_CONFIGURED", `${key} is not a valid identifier.`);
    }
  }
  return {
    nessie: {
      baseUrl: (config.NESSIE_BASE_URL ?? "").replace(/\/$/, ""),
      apiKey: config.NESSIE_API_KEY ?? "",
    },
    snowflake: {
      accountUrl: (config.SNOWFLAKE_ACCOUNT_URL ?? "").replace(/\/$/, ""),
      pat: config.SNOWFLAKE_PAT ?? "",
      role: config.SNOWFLAKE_ROLE ?? "",
      warehouse: config.SNOWFLAKE_WAREHOUSE ?? "",
      database: config.SNOWFLAKE_DATABASE ?? "",
      schema: config.SNOWFLAKE_SCHEMA ?? "",
      model: config.SNOWFLAKE_MODEL ?? "",
    },
  };
}

export function isSponsorConfigured(): boolean {
  try {
    getSponsorConfig();
    return true;
  } catch {
    return false;
  }
}
