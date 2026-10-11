import { DomainError } from "@/domain/errors";
import { databaseHost, databaseLabel, getConfig, getNeonConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { NeonClient } from "@/server/providers/neon";
import { appendSessionEvent } from "@/server/services/records";
import type { SnapshotStatus, SnapshotView } from "@/lib/view-types";
import type { SessionRow } from "@/server/services/session-service";

export const SNAPSHOT_PREFIX = "commoncart-snapshot-";

function client(): NeonClient | null {
  const config = getNeonConfig();
  return config ? new NeonClient(config) : null;
}

function unavailable(reason: string): SnapshotStatus {
  return { available: false, reason, database: databaseLabel(), parentBranch: null, snapshots: [] };
}

/** Whether snapshots can be taken, the branch they copy, and the snapshots that exist. */
export async function snapshotStatus(): Promise<SnapshotStatus> {
  const neon = client();
  if (!neon) return unavailable("Set NEON_API_KEY and NEON_PROJECT_ID to enable snapshots.");
  const host = databaseHost();
  if (!host?.endsWith(".neon.tech")) {
    return unavailable("The application database is not hosted on Neon.");
  }
  const [parent, branches] = await Promise.all([neon.branchForHost(host), neon.listBranches()]);
  if (!parent) return unavailable("Could not find the Neon branch serving this database.");
  const parentName = branches.find((branch) => branch.id === parent)?.name ?? parent;
  return {
    available: true,
    reason: null,
    database: databaseLabel(),
    parentBranch: parentName,
    snapshots: branches
      .filter((branch) => branch.name.startsWith(SNAPSHOT_PREFIX))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((branch) => ({ id: branch.id, name: branch.name, createdAt: branch.created_at })),
  };
}

/**
 * Freeze the whole demo database as a Neon branch (copy-on-write, no compute endpoint), e.g. to
 * keep the exact state judges saw. The live database is untouched.
 */
export async function createSnapshot(session: SessionRow): Promise<SnapshotView> {
  if (!getConfig().DEMO_CONTROLS_ENABLED) {
    throw new DomainError("DEMO_CONTROLS_DISABLED", "Demo controls are disabled.");
  }
  const neon = client();
  const host = databaseHost();
  if (!neon || !host?.endsWith(".neon.tech")) {
    throw new DomainError("INCOMPATIBLE_STATE", "Snapshots need a Neon-hosted database and API key.");
  }
  const parent = await neon.branchForHost(host);
  if (!parent) throw new DomainError("UPSTREAM_UNAVAILABLE", "Neon branch for this database not found.");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const branch = await neon.createBranch(`${SNAPSHOT_PREFIX}${stamp}-${session.id.slice(-6)}`, parent);
  await appendSessionEvent(getDb(), {
    sessionId: session.id,
    actor: "operator",
    type: "database_snapshot",
    payload: { branchId: branch.id, name: branch.name },
  });
  return { id: branch.id, name: branch.name, createdAt: branch.created_at };
}
