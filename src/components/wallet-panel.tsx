"use client";

import { Landmark, PlusCircle, Receipt } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LedgerList } from "@/components/ledger-list";
import { OperationStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { ApiError, announceRefresh, api } from "@/lib/api-client";
import { formatCents } from "@/lib/format";
import type { WalletView } from "@/lib/view-types";

const dueFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

const PRESETS = ["20.00", "50.00"];

function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The selected shopper's bank view, with top-ups and bill payments recorded at the bank. */
export function WalletPanel({ initial }: { initial: WalletView }) {
  const [wallet, setWallet] = useState(initial);
  const [amount, setAmount] = useState("25.00");
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const bank = wallet.provider === "nessie" ? "Nessie" : "the simulated bank";
  const bankLabel = wallet.provider === "nessie" ? "Nessie" : "ledger";

  async function run(key: string, path: string, body: unknown, success: (status: string) => string) {
    setBusy(key);
    setNotice(null);
    try {
      const data = await api<{ wallet: WalletView; operationStatus: string }>(path, { body });
      setWallet(data.wallet);
      setNotice({ tone: data.operationStatus === "failed" ? "error" : "info", text: success(data.operationStatus) });
      announceRefresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof ApiError ? error.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  function statusText(what: string, status: string) {
    if (status === "confirmed") return `${what} recorded with ${bank}.`;
    if (status === "failed") return `${what} was not accepted by ${bank}.`;
    return `${what} is waiting on ${bank}; it won't be sent twice. Use "Check status" below.`;
  }

  async function addFunds(event: FormEvent, value = amount) {
    event.preventDefault();
    await run("deposit", "/api/wallet/deposits", { amount: value, requestKey }, (status) =>
      statusText(`Top-up of $${value}`, status),
    );
    setRequestKey(newRequestKey());
  }

  async function reconcile(operationId: string) {
    setBusy(operationId);
    try {
      await api(`/api/operations/${operationId}/reconcile`, { body: {} });
      setWallet(await api<WalletView>("/api/wallet"));
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Check failed." });
    } finally {
      setBusy(null);
    }
  }

  const tiles = [
    {
      label: wallet.provider === "nessie" ? "Balance reported by Nessie" : "Balance in the simulated bank",
      value: wallet.account.providerBalanceCents,
    },
    { label: "After verified activity", value: wallet.effectiveBalanceCents },
    { label: "Bills due before pickup", value: -wallet.billsDueCents },
    { label: "Personal cushion", value: -wallet.cushionCents },
    ...(wallet.pendingOutCents > 0 ? [{ label: "Waiting on the bank", value: -wallet.pendingOutCents }] : []),
  ];
  const unresolved = wallet.activity.filter(
    (entry) => entry.groupId === null && ["pending", "unknown"].includes(entry.status),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-savings">Wallet</p>
          <h1 className="text-3xl font-extrabold tracking-tight">{wallet.name}&apos;s account</h1>
          <p className="text-muted">
            {wallet.account.nickname}
            {wallet.account.maskedNumber ? ` · ${wallet.account.maskedNumber}` : ""}
          </p>
        </div>
        <Badge tone={wallet.provider === "nessie" ? "info" : "neutral"} icon={<Landmark size={14} aria-hidden />}>
          {wallet.provider === "nessie" ? "Capital One Nessie sandbox" : "Simulated bank ledger"}
        </Badge>
      </div>

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

      <Card className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {tiles.map((tile) => (
            <div key={tile.label} className="rounded-xl bg-sunken px-3 py-2">
              <p className="text-xs text-muted">{tile.label}</p>
              <p className="text-lg font-bold">
                {tile.value < 0 ? "−" : ""}
                {formatCents(Math.abs(tile.value))}
              </p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-savings-soft px-4 py-3">
          <p className="font-semibold text-savings-strong">Safe to contribute to groups</p>
          <p className="text-3xl font-extrabold text-savings-strong">
            {formatCents(Math.max(0, wallet.spendableCents))}
          </p>
        </div>
        <p className="text-sm text-muted">
          {wallet.balanceEffects
            ? "The simulated bank moves money between accounts, so its balance already reflects your activity."
            : "Nessie records every top-up, bill payment, contribution and return but doesn't change balances in this sandbox, so CommonCart adds up the records it has verified with Nessie."}{" "}
          Bills due before the next pickup
          {wallet.nextPickupLabel ? ` (${wallet.nextPickupLabel})` : ""} and your cushion come first.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <SectionTitle className="flex items-center gap-2">
            <PlusCircle size={20} aria-hidden /> Add funds
          </SectionTitle>
          <p className="text-sm text-muted">Mock money, recorded as a deposit with {bank}.</p>
          <form onSubmit={(event) => void addFunds(event)} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={(event) => void addFunds(event as unknown as FormEvent, preset)}
                >
                  +${preset.replace(".00", "")}
                </Button>
              ))}
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Other amount
              <span className="flex items-center rounded-xl border border-line bg-surface px-3 font-normal">
                <span className="text-muted" aria-hidden>
                  $
                </span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="w-full bg-transparent px-1 py-2 outline-none"
                  aria-label="Amount to add in dollars"
                />
              </span>
            </label>
            <div>
              <Button type="submit" disabled={busy !== null}>
                {busy === "deposit" ? "Adding…" : `Add $${amount || "0"}`}
              </Button>
            </div>
          </form>
        </Card>

        <Card className="flex flex-col gap-3">
          <SectionTitle className="flex items-center gap-2">
            <Receipt size={20} aria-hidden /> Upcoming bills
          </SectionTitle>
          {wallet.bills.length === 0 ? (
            <p className="text-sm text-muted">No bills on this account.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {wallet.bills.map((bill) => {
                const paid = ["completed", "paid"].includes(bill.status.toLowerCase());
                return (
                  <li key={bill.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>
                      <strong>{bill.payee}</strong>
                      <span className="text-muted">
                        {" "}
                        · due {bill.dueDate ? dueFormat.format(new Date(`${bill.dueDate}T12:00:00Z`)) : "unknown"}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <strong>{formatCents(bill.amountCents)}</strong>
                      {paid ? (
                        <Badge tone="savings">Paid</Badge>
                      ) : bill.payment && bill.payment !== "failed" ? (
                        <OperationStatusBadge status={bill.payment} label={`Payment ${bill.payment}`} />
                      ) : (
                        <>
                          {bill.dueBeforePickup ? <Badge tone="warn">Before pickup</Badge> : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy !== null}
                            onClick={() =>
                              void run(`bill-${bill.id}`, `/api/wallet/bills/${bill.id}/pay`, {}, (status) =>
                                statusText(`Payment to ${bill.payee}`, status),
                              )
                            }
                          >
                            {busy === `bill-${bill.id}` ? "Paying…" : "Pay now"}
                          </Button>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted">
            Bills live in your {wallet.provider === "nessie" ? "Nessie" : "simulated"} account. Paying
            one records the payment at the bank and marks the bill paid.
          </p>
        </Card>
      </div>

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Activity</SectionTitle>
          {unresolved.map((entry) => (
            <Button
              key={entry.operationId}
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void reconcile(entry.operationId)}
            >
              {busy === entry.operationId ? "Checking…" : `Check status of ${formatCents(entry.amountCents)}`}
            </Button>
          ))}
        </div>
        <LedgerList entries={wallet.activity} bankLabel={bankLabel} />
      </Card>
    </div>
  );
}
