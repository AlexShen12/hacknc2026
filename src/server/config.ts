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
  NEON_API_KEY: optional,
  NEON_PROJECT_ID: optional,
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

export interface NeonConfig {
  apiKey: string;
  projectId: string;
}

/** Accept host-only values (e.g. `example.com`) and strip trailing slashes. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Sponsor sessions use live Capital One Nessie banking; analytics always run on the application's
 * Postgres database (Neon when deployed). A missing Nessie value never downgrades to rehearsal.
 */
export function getSponsorConfig(config = getConfig()): { nessie: NessieConfig } {
  const required = {
    NESSIE_BASE_URL: config.NESSIE_BASE_URL,
    NESSIE_API_KEY: config.NESSIE_API_KEY,
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
  return {
    nessie: {
      baseUrl: normalizeUrl(config.NESSIE_BASE_URL ?? ""),
      apiKey: config.NESSIE_API_KEY ?? "",
    },
  };
}

/** Neon API access for database snapshots; null when not configured. */
export function getNeonConfig(config = getConfig()): NeonConfig | null {
  if (!config.NEON_API_KEY || !config.NEON_PROJECT_ID) return null;
  return { apiKey: config.NEON_API_KEY, projectId: config.NEON_PROJECT_ID };
}

/** Hostname of the application database, used to label it and find its Neon branch. */
export function databaseHost(config = getConfig()): string | null {
  try {
    return new URL(config.DATABASE_URL).hostname;
  } catch {
    return null;
  }
}

/** "Neon Postgres" when the application database is hosted on Neon, otherwise "Postgres". */
export function databaseLabel(config = getConfig()): string {
  return databaseHost(config)?.endsWith(".neon.tech") ? "Neon Postgres" : "Postgres";
}

export function isSponsorConfigured(): boolean {
  try {
    getSponsorConfig();
    return true;
  } catch {
    return false;
  }
}
