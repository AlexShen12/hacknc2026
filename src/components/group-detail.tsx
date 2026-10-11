"use client";

import {
  CheckCircle2,
  CircleAlert,
  HandCoins,
  LogOut,
  MapPin,
  PackageCheck,
  ShoppingCart,
  UserSearch,
  Users,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { AllocationTable } from "@/components/allocation-table";
import { CollectionLedger } from "@/components/collection-ledger";
import { ExplanationCard } from "@/components/explanation-card";
import { AutomationCard, InviteCard, JoinCard } from "@/components/group-panels";
import { GroupStatusBadge, OperationStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { OperationKind, ProviderMode } from "@/domain/types";
import { hasLeft } from "@/domain/types";
import { ApiError, announceRefresh, api, REFRESH_EVENT } from "@/lib/api-client";
import { formatCents } from "@/lib/format";
import type { GroupAction, GroupView } from "@/lib/view-types";

const BLOCKER_TEXT: Record<string, string> = {
  awaiting_consent: "Waiting for every member to confirm their terms.",
  contribution_missing: "Waiting for contributions.",
  contribution_unresolved: "A contribution is still being checked with the bank.",
  return_unresolved: "A returned contribution has not been confirmed yet, so purchase is paused.",
  departure_in_progress: "Someone is leaving; their contribution is being returned first.",
  total_mismatch: "Confirmed funds don't equal the package total yet.",
  collection_balance_mismatch:
    "The group's collection account doesn't match confirmed contributions.",
  bank_outcome_unknown:
    "We couldn't confirm what happened with a bank operation. Purchase is blocked until it is checked — it will not be resent automatically.",
  operation_in_flight: "A bank operation is being sent.",
  contribution_pending: "A contribution is pending at the bank.",
  return_pending: "A return transfer is pending at the bank.",
  purchase_pending: "The purchase is pending at the bank.",
  return_failed: "A return transfer failed. Purchase stays blocked until it succeeds.",
  vacant_share:
    "A share is open. Find a replacement for exactly the same amount, or cancel the group.",
  provider_record_mismatch:
    "A bank record no longer matches what we recorded. Purchase is blocked until it is checked.",
  awaiting_replacement_consent:
    "A replacement has been offered the open share and needs to confirm.",
};

const KIND_LABEL: Record<OperationKind, string> = {
  deposit: "Wallet top-up",
  bill_payment: "Bill payment",
  contribution: "Contribution",
  return: "Return",
  purchase: "Merchant purchase",
};

export function GroupDetail({
  initial,
  mode,
  inviteCode,
}: {
  initial: GroupView;
  mode: ProviderMode;
  inviteCode: string | null;
}) {
  const [group, setGroup] = useState(initial);
  const [confirmAutoPay, setConfirmAutoPay] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [dialog, setDialog] = useState<"confirm" | "withdraw" | "cancel" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGroup(await api<GroupView>(`/api/groups/${initial.id}`));
    } catch {
      // Keep showing the last known state.
    }
  }, [initial.id]);

  useEffect(() => {
    const listener = () => void refresh();
    window.addEventListener(REFRESH_EVENT, listener);
    return () => window.removeEventListener(REFRESH_EVENT, listener);
  }, [refresh]);

  const unresolved = group.operations.some((op) =>
    ["pending", "dispatching", "unknown"].includes(op.status),
  );
  useEffect(() => {
    if (!unresolved) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [unresolved, refresh]);

  async function act(action: GroupAction, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setNotice(null);
    try {
      const data = await api<GroupView | { group: GroupView; operationStatus: string }>(
        `/api/groups/${group.id}/${action}`,
        { body: { expectedVersion: group.version, ...extra } },
      );
      const next = "group" in data ? data.group : data;
      setGroup(next);
      if ("operationStatus" in data && data.operationStatus !== "confirmed") {
        setNotice({
          tone: "info",
          text:
            data.operationStatus === "pending"
              ? "Contribution pending — the bank hasn't confirmed it yet."
              : data.operationStatus === "unknown"
                ? "We couldn't confirm your contribution. It will not be resent; use “Check status”."
                : "Your contribution was not accepted. You can try again.",
        });
      }
      announceRefresh();
    } catch (error) {
      const err = error instanceof ApiError ? error : null;
      setNotice({ tone: "error", text: err?.message ?? "Something went wrong." });
      if (err?.status === 409) await refresh();
    } finally {
      setBusy(null);
      setDialog(null);
    }
  }

  async function reconcile(operationId: string) {
    setBusy(operationId);
    try {
      const data = await api<{ group: GroupView | null; operationStatus: string }>(
        `/api/operations/${operationId}/reconcile`,
        { body: {} },
      );
      if (data.group) setGroup(data.group);
      setNotice({
        tone: "info",
        text:
          data.operationStatus === "unknown"
            ? "Still unconfirmed. This needs operator investigation; nothing was resent."
            : `Bank status: ${data.operationStatus}.`,
      });
      announceRefresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Check failed." });
    } finally {
      setBusy(null);
    }
  }

  const mine = group.allocations.find(
    (row) => row.shopperId === group.viewer.shopperId && !hasLeft(row.state),
  );
  const actions = new Set(group.viewer.actions);
  const progress = Math.min(100, Math.round((group.retainedCents / group.totalCents) * 100));

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <Image
            src={group.offer.image}
            alt=""
            width={80}
            height={80}
            className="size-20 rounded-xl"
          />
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-2">
              <GroupStatusBadge status={group.status} />
              <Badge>{group.offer.sourceLabel}</Badge>
            </div>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight">
              {group.offer.retailerLabel} {group.offer.productName}
            </h1>
            <p className="text-sm text-muted">
              {group.offer.packageQuantity} {group.offer.unit} for {formatCents(group.totalCents)} ·
              Pickup {group.pickupLabel} at {group.pickupZoneLabel} · Organizer{" "}
              {group.organizerName ?? "needed"}
            </p>
            {group.store ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted">
                <MapPin size={14} aria-hidden className="text-savings" />
                Bought at <strong className="text-ink">{group.store.name}</strong> ·{" "}
                {group.store.addressLine} ·{" "}
                <a
                  href={group.store.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-savings hover:underline"
                >
                  Map
                </a>
                {group.store.merchantRef && mode === "sponsor" ? (
                  <span className="text-xs">· Nessie merchant {group.store.merchantRef.slice(0, 8)}…</span>
                ) : null}
              </p>
            ) : null}
          </div>
          {mine ? (
            <div className="w-full rounded-xl bg-savings-soft px-4 py-3 sm:w-auto sm:text-right">
              <p className="text-xs font-semibold text-savings-strong">Your share</p>
              <p className="text-2xl font-extrabold">{formatCents(mine.contributionCents)}</p>
              <p className="text-sm">
                {mine.quantity} {group.offer.unit} ·{" "}
                <span className="font-semibold text-savings">
                  save {formatCents(mine.savingsCents)}
                </span>
              </p>
            </div>
          ) : null}
        </div>
        {group.statusReason ? (
          <p className="text-sm text-muted">Reason: {group.statusReason.replaceAll("_", " ")}</p>
        ) : null}
        {group.status !== "open" ? (
          <ExplanationCard
            groupId={group.id}
            initial={group.explanation}
            key={group.explanation?.proposalVersion ?? "none"}
          />
        ) : null}
      </Card>

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            notice.tone === "error"
              ? "rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
              : "rounded-xl border border-info/30 bg-info-soft px-4 py-3 text-sm font-medium text-info"
          }
        >
          {notice.text}
        </div>
      ) : null}

      {group.status === "open" ? (
        <Card className="flex flex-col gap-3">
          <SectionTitle className="flex items-center gap-2">
            <Users size={20} aria-hidden /> Filling the package
          </SectionTitle>
          <div
            className="h-3 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={group.offer.packageQuantity}
            aria-valuenow={group.offer.packageQuantity - group.remainingUnits}
            aria-label="Units claimed"
          >
            <div
              className="h-full rounded-full bg-savings transition-all"
              style={{
                width: `${Math.round(((group.offer.packageQuantity - group.remainingUnits) / group.offer.packageQuantity) * 100)}%`,
              }}
            />
          </div>
          <p className="text-sm">
            <strong>
              {group.offer.packageQuantity - group.remainingUnits} of {group.offer.packageQuantity}{" "}
              {group.offer.unit}
            </strong>{" "}
            claimed · {group.remainingUnits} left ·{" "}
            {group.visibility === "public" ? "listed for nearby shoppers" : "invite only"}
          </p>
          {mine ? <InviteCard group={group} /> : null}
          <p className="text-xs text-muted">
            Nobody is charged until the package is exactly full. Shares are priced by quantity.
          </p>
        </Card>
      ) : null}

      {actions.has("join") ? (
        <JoinCard group={group} inviteCode={inviteCode} onUpdated={setGroup} key={group.version} />
      ) : null}

      {group.viewer.actions.some((action) => action !== "join") ? (
        <Card className="flex flex-col gap-3">
          <SectionTitle>Next step</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {actions.has("confirm") ? (
              <Button onClick={() => setDialog("confirm")} disabled={busy !== null}>
                <CheckCircle2 size={18} aria-hidden /> Review and confirm my terms
              </Button>
            ) : null}
            {actions.has("contribute") && mine ? (
              <Button onClick={() => void act("contribute")} disabled={busy !== null}>
                <HandCoins size={18} aria-hidden />
                {busy === "contribute"
                  ? "Sending…"
                  : `Contribute ${formatCents(mine.contributionCents)}`}
              </Button>
            ) : null}
            {actions.has("purchase") ? (
              <Button onClick={() => void act("purchase")} disabled={busy !== null}>
                <ShoppingCart size={18} aria-hidden />
                {busy === "purchase"
                  ? "Recording…"
                  : `Record purchase (${formatCents(group.totalCents)})`}
              </Button>
            ) : null}
            {actions.has("pickup") ? (
              <Button onClick={() => void act("pickup")} disabled={busy !== null}>
                <PackageCheck size={18} aria-hidden /> I picked up my {mine?.quantity}{" "}
                {group.offer.unit}
              </Button>
            ) : null}
            {actions.has("replace") ? (
              <Button
                variant="secondary"
                onClick={() => void act("replace")}
                disabled={busy !== null}
              >
                <UserSearch size={18} aria-hidden />
                {busy === "replace"
                  ? "Searching…"
                  : group.blockers.includes("awaiting_replacement_consent")
                    ? "Offer to someone else"
                    : "Find a replacement"}
              </Button>
            ) : null}
            {actions.has("withdraw") ? (
              <Button
                variant="secondary"
                onClick={() => setDialog("withdraw")}
                disabled={busy !== null}
              >
                <LogOut size={18} aria-hidden /> Leave group
              </Button>
            ) : null}
            {actions.has("cancel") ? (
              <Button variant="danger" onClick={() => setDialog("cancel")} disabled={busy !== null}>
                <XCircle size={18} aria-hidden /> Cancel group
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <AutomationCard group={group} onUpdated={setGroup} />

      {group.blockers.length > 0 &&
      !["fulfilled", "cancelled", "purchased"].includes(group.status) ? (
        <Card className="flex flex-col gap-2 border-warn/30 bg-warn-soft/50">
          <p className="flex items-center gap-2 font-semibold text-warn">
            <CircleAlert size={18} aria-hidden /> What we&apos;re waiting on
          </p>
          <ul className="list-disc pl-6 text-sm">
            {group.blockers.map((blocker) => (
              <li key={blocker}>{BLOCKER_TEXT[blocker] ?? blocker}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <SectionTitle>Funding</SectionTitle>
          <p className="text-sm text-muted">
            {mode === "sponsor" ? "Capital One Nessie sandbox" : "Simulated bank ledger"} · group
            collection account
          </p>
        </div>
        <div>
          <div
            className="h-3 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={group.totalCents}
            aria-valuenow={group.retainedCents}
            aria-label="Confirmed funds collected"
          >
            <div
              className="h-full rounded-full bg-savings transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-sm">
            <strong>{formatCents(group.retainedCents)}</strong> confirmed of{" "}
            {formatCents(group.totalCents)}
            {group.collectionBalanceCents !== null
              ? ` · collection account balance ${formatCents(group.collectionBalanceCents)}`
              : ""}
          </p>
          <p className="text-xs text-muted">
            Pledges are promises, not payments. Only confirmed contributions count toward the total.
          </p>
        </div>
        <AllocationTable group={group} showFunding />
      </Card>

      {group.operations.length > 0 ? <CollectionLedger groupId={group.id} /> : null}

      {group.operations.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <SectionTitle>Money movements</SectionTitle>
          <ul className="flex flex-col divide-y divide-line">
            {group.operations.map((op) => (
              <li
                key={op.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div>
                  <p className="font-semibold">
                    {KIND_LABEL[op.kind]}
                    {op.shopperName ? ` · ${op.shopperName}` : ""} · {formatCents(op.amountCents)}
                  </p>
                  <p className="text-xs text-muted">
                    {op.providerId
                      ? `Bank reference ${op.providerId.slice(-10)}`
                      : "No bank reference yet"}
                    {op.attemptCount > 1 ? ` · ${op.attemptCount} attempts` : ""}
                    {op.lastError ? ` · ${op.lastError.code}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <OperationStatusBadge status={op.status} />
                  {op.status === "pending" || op.status === "unknown" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void reconcile(op.id)}
                      disabled={busy !== null}
                    >
                      {busy === op.id ? "Checking…" : "Check status"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {mine ? (
        <Dialog
          open={dialog === "confirm"}
          onOpenChange={(open) => setDialog(open ? "confirm" : null)}
          title="Confirm your terms"
          description="You're pledging to pay this exact amount once everyone confirms. Nothing is charged yet."
        >
          <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Product</dt>
            <dd className="font-semibold">
              {group.offer.retailerLabel} {group.offer.productName}
            </dd>
            <dt className="text-muted">Your quantity</dt>
            <dd className="font-semibold">
              {mine.quantity} of {group.offer.packageQuantity} {group.offer.unit}
            </dd>
            <dt className="text-muted">You pay</dt>
            <dd className="font-semibold">{formatCents(mine.contributionCents)}</dd>
            <dt className="text-muted">Buying alone</dt>
            <dd>{formatCents(mine.baselineCents)}</dd>
            <dt className="text-muted">You save</dt>
            <dd className="font-semibold text-savings">{formatCents(mine.savingsCents)}</dd>
            <dt className="text-muted">Pickup</dt>
            <dd>{group.pickupLabel}</dd>
          </dl>
          <label className="mb-5 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmAutoPay}
              onChange={(event) => setConfirmAutoPay(event.target.checked)}
            />
            <span>
              <strong>Pay automatically</strong> once everyone has confirmed, so you don&apos;t need
              to come back.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Not now
            </Button>
            <Button
              onClick={() => void act("confirm", { autoPay: confirmAutoPay })}
              disabled={busy !== null}
            >
              {busy === "confirm"
                ? "Confirming…"
                : confirmAutoPay
                  ? "Confirm and pay automatically"
                  : "Confirm my share"}
            </Button>
          </div>
        </Dialog>
      ) : null}

      <Dialog
        open={dialog === "withdraw"}
        onOpenChange={(open) => setDialog(open ? "withdraw" : null)}
        title="Leave this group?"
        description={
          mine?.contributionStatus === "confirmed"
            ? `Your ${formatCents(mine.contributionCents)} contribution will be returned in full. Purchasing pauses until the return is confirmed. Other members keep their prices.`
            : "Your share will open up for someone else. Other members keep their prices."
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDialog(null)}>
            Stay
          </Button>
          <Button variant="danger" onClick={() => void act("withdraw")} disabled={busy !== null}>
            {busy === "withdraw" ? "Leaving…" : "Leave group"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "cancel"}
        onOpenChange={(open) => setDialog(open ? "cancel" : null)}
        title="Cancel the whole group?"
        description="Every confirmed contribution will be returned. The group is cancelled only after all returns are confirmed."
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDialog(null)}>
            Keep group
          </Button>
          <Button variant="danger" onClick={() => void act("cancel")} disabled={busy !== null}>
            {busy === "cancel" ? "Cancelling…" : "Cancel group"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
