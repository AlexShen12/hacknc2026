"use client";

import { Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { GroupStatusBadge, OperationStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { hasLeft } from "@/domain/types";
import { announceRefresh, api, REFRESH_EVENT } from "@/lib/api-client";
import { formatCents } from "@/lib/format";
import type { GroupAction, OperatorView, SnapshotStatus } from "@/lib/view-types";

const ACTION_LABEL: Record<GroupAction, string> = {
  confirm: "Confirm",
  contribute: "Contribute",
  withdraw: "Leave",
  replace: "Find replacement",
  cancel: "Cancel group",
  purchase: "Purchase",
  pickup: "Pick up",
  join: "Join",
};

/**
 * Session-scoped scenario controls. Every button calls an allowlisted demo action that runs the same
 * services as the consumer UI for one of this session's seeded shoppers.
 */
export function OperatorPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<OperatorView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<SnapshotStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api<OperatorView>("/api/demo/operator"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load operator view.");
    }
  }, []);

  const loadSnapshots = useCallback(async () => {
    try {
      setSnapshots(await api<SnapshotStatus>("/api/demo/snapshots"));
    } catch (error) {
      setSnapshots({
        available: false,
        reason: error instanceof Error ? error.message : "Neon status unavailable.",
        database: "",
        parentBranch: null,
        snapshots: [],
      });
    }
  }, []);

  async function snapshot() {
    setBusy("snapshot");
    setMessage(null);
    try {
      await api("/api/demo/snapshots", { body: {} });
      await loadSnapshots();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Snapshot failed.");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    void load();
    void loadSnapshots();
    const listener = () => void load();
    window.addEventListener(REFRESH_EVENT, listener);
    return () => window.removeEventListener(REFRESH_EVENT, listener);
  }, [open, load, loadSnapshots]);

  async function run(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setMessage(null);
    try {
      await api("/api/demo/actions", { body });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(null);
      await load();
      router.refresh();
      announceRefresh();
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      await api("/api/demo/reset", { body: {} });
      setOpen(false);
      router.push("/shop");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const session = view?.session;
  const groups = (view?.groups ?? []).filter(
    (group) => group.status !== "cancelled" || group.operations.length > 0,
  );

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Settings2 size={16} aria-hidden /> Demo controls
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        side
        title="Demo operator"
        description="Advance seeded shoppers, inject rehearsal faults and inspect provider status."
      >
        {!view || !session ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6 text-sm">
            {message ? (
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 font-medium text-danger"
              >
                {message}
              </p>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Session</h3>
              <div className="flex flex-wrap gap-2">
                <Badge tone={session.mode === "sponsor" ? "info" : "neutral"}>
                  Mode: {session.mode}
                </Badge>
                <Badge tone={session.providers.banking.verified ? "savings" : "warn"}>
                  Bank: {session.providers.banking.name}
                  {session.providers.banking.verified ? "" : " (unverified)"}
                </Badge>
                <Badge>Analytics: {session.providers.analytics}</Badge>
                <Badge>Offers: {session.providers.retail}</Badge>
              </div>
              <p className="text-xs text-muted">
                Amount unit: {session.providers.banking.amountUnit} · correlation lookup{" "}
                {session.providers.banking.correlationLookup ? "available" : "not verified"} ·
                scenario {session.scenarioVersion} · catalog {session.catalogVersion}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void reset()}
                >
                  Reset demo (new session)
                </Button>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Database</h3>
              {!snapshots ? (
                <p className="text-xs text-muted">Checking Neon…</p>
              ) : snapshots.available ? (
                <>
                  <p className="text-xs text-muted">
                    {snapshots.database} · branch <strong>{snapshots.parentBranch}</strong>. A snapshot
                    copies the whole demo database to a new Neon branch (no compute) and leaves the live
                    data untouched.
                  </p>
                  <div>
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void snapshot()}>
                      {busy === "snapshot" ? "Creating branch…" : "Snapshot to Neon branch"}
                    </Button>
                  </div>
                  {snapshots.snapshots.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-xs">
                      {snapshots.snapshots.map((item) => (
                        <li key={item.id} className="rounded-lg bg-sunken px-2 py-1">
                          <span className="font-mono">{item.name}</span>{" "}
                          <span className="text-muted">
                            · {new Date(item.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted">Snapshots unavailable: {snapshots.reason}</p>
              )}
            </section>

            {session.mode === "rehearsal" ? (
              <section className="flex flex-col gap-2">
                <h3 className="font-bold">Next bank operation (rehearsal only)</h3>
                <div
                  className="flex flex-wrap gap-2"
                  role="radiogroup"
                  aria-label="Fault for next bank operation"
                >
                  {([null, "pending", "unknown", "reject"] as const).map((fault) => (
                    <Button
                      key={fault ?? "none"}
                      size="sm"
                      variant={session.rehearsalFault === fault ? "primary" : "secondary"}
                      role="radio"
                      aria-checked={session.rehearsalFault === fault}
                      disabled={busy !== null}
                      onClick={() => void run(`fault-${fault}`, { action: "set_fault", fault })}
                    >
                      {fault === null
                        ? "Normal"
                        : fault === "pending"
                          ? "Stays pending"
                          : fault === "unknown"
                            ? "Lose response"
                            : "Bank rejects"}
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="flex flex-col gap-3">
              <h3 className="font-bold">Groups</h3>
              {groups.length === 0 ? (
                <p className="text-muted">No groups yet. Enter a need as a shopper.</p>
              ) : null}
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">
                      {group.offer.retailerLabel} {group.offer.productName}{" "}
                      <span className="text-xs text-muted">
                        v{group.version} ·{" "}
                        {group.origin === "organizer" ? "started by organizer" : "matched"}
                        {group.autoPurchase ? " · auto-purchase" : ""}
                      </span>
                    </p>
                    <GroupStatusBadge status={group.status} />
                  </div>
                  <p className="text-xs text-muted">
                    Confirmed {formatCents(group.retainedCents)} / {formatCents(group.totalCents)} ·
                    collection balance{" "}
                    {group.collectionBalanceCents === null
                      ? "—"
                      : formatCents(group.collectionBalanceCents)}{" "}
                    ·{" "}
                    matched on {group.analytics.engine}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {group.allocations.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span>
                          <strong>{row.name}</strong>{" "}
                          <span className="text-xs text-muted">
                            {row.state}
                            {row.consented ? " · confirmed" : ""}
                            {row.contributionStatus ? ` · paid ${row.contributionStatus}` : ""}
                            {row.returnStatus ? ` · return ${row.returnStatus}` : ""}
                          </span>
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {(group.memberActions[row.shopperId] ?? []).map((action) => (
                            <Button
                              key={action}
                              size="sm"
                              variant={
                                action === "withdraw" || action === "cancel"
                                  ? "danger"
                                  : "secondary"
                              }
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`${group.id}-${row.id}-${action}`, {
                                  action,
                                  actorShopperId: row.shopperId,
                                  groupId: group.id,
                                  expectedVersion: group.version,
                                })
                              }
                            >
                              {ACTION_LABEL[action]} as {row.name}
                            </Button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {group.joinSlot ? (
                    <div className="flex flex-col gap-1.5 border-t border-line pt-2">
                      <p className="text-xs text-muted">
                        {group.joinSlot.mode === "slot"
                          ? `Open share: ${group.joinSlot.quantity} ${group.offer.unit}`
                          : `${group.remainingUnits} ${group.offer.unit} left`}
                        {group.inviteCode
                          ? ` · invite ${group.inviteCode} (${group.visibility})`
                          : ""}
                      </p>
                      <span className="flex flex-wrap gap-1">
                        {session.shoppers
                          .filter(
                            (shopper) =>
                              !group.allocations.some(
                                (row) => row.shopperId === shopper.id && !hasLeft(row.state),
                              ),
                          )
                          .map((shopper) => (
                            <Button
                              key={shopper.id}
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`${group.id}-join-${shopper.id}`, {
                                  action: "join",
                                  actorShopperId: shopper.id,
                                  groupId: group.id,
                                  expectedVersion: group.version,
                                })
                              }
                            >
                              Join as {shopper.displayName}
                            </Button>
                          ))}
                      </span>
                    </div>
                  ) : null}
                  {group.operations.some((op) => op.status !== "confirmed") ? (
                    <ul className="flex flex-col gap-1.5 border-t border-line pt-2">
                      {group.operations
                        .filter((op) => op.status !== "confirmed")
                        .map((op) => (
                          <li
                            key={op.id}
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <span className="text-xs">
                              {op.kind} {op.shopperName ?? ""} {formatCents(op.amountCents)}{" "}
                              {op.lastError ? `(${op.lastError.code})` : ""}
                            </span>
                            <span className="flex items-center gap-1">
                              <OperationStatusBadge status={op.status} />
                              {op.status === "pending" ||
                              op.status === "unknown" ||
                              op.status === "dispatching" ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void run(`rec-${op.id}`, {
                                      action: "reconcile",
                                      operationId: op.id,
                                    })
                                  }
                                >
                                  Reconcile
                                </Button>
                              ) : null}
                              {op.status === "failed" && op.kind === "return" ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void run(`retry-${op.id}`, {
                                      action: "retry_operation",
                                      operationId: op.id,
                                    })
                                  }
                                >
                                  Retry return
                                </Button>
                              ) : null}
                            </span>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {[
                    "awaiting_confirmation",
                    "funding",
                    "ready_to_purchase",
                    "replacement_needed",
                  ].includes(group.status) ? (
                    <div className="flex flex-wrap gap-2 border-t border-line pt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`expire-${group.id}`, {
                            action: "expire_offer",
                            groupId: group.id,
                          })
                        }
                      >
                        Expire this offer
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Mock account balances (operator only)</h3>
              <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {view.balances.map((row) => (
                  <li key={row.shopperId} className="rounded-lg bg-sunken px-2 py-1">
                    {row.name}:{" "}
                    {row.balanceCents === null ? "unavailable" : formatCents(row.balanceCents)}
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Event log</h3>
              <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-xs">
                {view.events.map((event) => (
                  <li key={event.id} className="text-muted">
                    <span className="text-ink">{event.type}</span> ·{" "}
                    {event.actor.replace(/^demo:/, "demo ")}
                    {event.seq !== null ? ` · #${event.seq}` : ""}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </Dialog>
    </>
  );
}
