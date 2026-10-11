"use client";

import { Check, Copy, Link2, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { estimateBaseline } from "@/domain/baseline";
import { quoteShareCents } from "@/domain/open-group";
import { ApiError, announceRefresh, api } from "@/lib/api-client";
import { formatCents } from "@/lib/format";
import type { GroupView } from "@/lib/view-types";

type Update = (group: GroupView) => void;

/** Join an organizer-created group: any fitting quantity while open, or exactly a vacated share. */
export function JoinCard({
  group,
  inviteCode,
  onUpdated,
}: {
  group: GroupView;
  inviteCode: string | null;
  onUpdated: Update;
}) {
  const slot = group.joinSlot;
  const smallest = group.offer.baselines
    .map((row) => row.quantity)
    .filter((value) => value <= group.remainingUnits)
    .sort((a, b) => a - b)[0];
  const [quantity, setQuantity] = useState(
    String(slot?.mode === "slot" ? slot.quantity : (smallest ?? group.remainingUnits)),
  );
  const fixed = slot?.mode === "slot";
  const units = Number(quantity);
  const quote =
    slot?.mode === "slot"
      ? slot.contributionCents
      : Number.isInteger(units) && units > 0
        ? quoteShareCents(group.totalCents, units, group.offer.packageQuantity)
        : null;
  const estimate = estimateBaseline(group.offer.baselines, units);
  // Uneven splits are quoted rounded up; the final share can only be a cent lower.
  const roundsDown =
    slot?.mode !== "slot" &&
    Number.isInteger(units) &&
    units > 0 &&
    (group.totalCents * units) % group.offer.packageQuantity !== 0;
  const baseline = estimate?.baselineCents;
  const [maxContribution, setMaxContribution] = useState(quote ? (quote / 100).toFixed(2) : "");
  const [autoPay, setAutoPay] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!slot) return null;
  const inviteOnly = group.visibility === "invite" && !inviteCode;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      onUpdated(
        await api<GroupView>(`/api/groups/${group.id}/join`, {
          body: {
            expectedVersion: group.version,
            quantity: units,
            maxContribution,
            autoPay,
            inviteCode,
          },
        }),
      );
      announceRefresh();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fields ?? {});
        setMessage(error.message);
      } else setMessage("Could not join. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 border-savings/40">
      <SectionTitle className="flex items-center gap-2">
        <UserPlus size={20} aria-hidden />
        {fixed ? "Take the open share" : "Join this group"}
      </SectionTitle>
      {inviteOnly ? (
        <p className="text-sm text-muted">
          This group is invite-only. Ask the organizer for the link.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              How many {group.offer.unit}?
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={group.remainingUnits}
                value={quantity}
                readOnly={fixed}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next > 0) {
                    const nextQuote = quoteShareCents(
                      group.totalCents,
                      next,
                      group.offer.packageQuantity,
                    );
                    setMaxContribution((nextQuote / 100).toFixed(2));
                  }
                }}
                className="rounded-xl border border-line bg-surface px-3 py-2 font-normal read-only:bg-sunken"
              />
              <span className="text-xs font-normal text-muted">
                {fixed
                  ? "Replacements take exactly the share that opened up."
                  : `${group.remainingUnits} available. Known prices for ${group.offer.baselines.map((row) => row.quantity).join(", ")}; other amounts are estimated.`}
              </span>
              {errors.quantity ? (
                <span role="alert" className="font-medium text-danger">
                  {errors.quantity}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Most you&apos;ll contribute
              <span className="flex items-center rounded-xl border border-line bg-surface px-3 font-normal">
                <span className="text-muted" aria-hidden>
                  $
                </span>
                <input
                  inputMode="decimal"
                  value={maxContribution}
                  onChange={(event) => setMaxContribution(event.target.value)}
                  className="w-full bg-transparent px-1 py-2 outline-none"
                  aria-label="Most you'll contribute in dollars"
                />
              </span>
              {errors.maxContribution ? (
                <span role="alert" className="font-medium text-danger">
                  {errors.maxContribution}
                </span>
              ) : null}
            </label>
          </div>
          {quote !== null ? (
            <p className="text-sm">
              Your share: {roundsDown ? "up to " : ""}
              <strong>{formatCents(quote)}</strong>
              {baseline !== undefined ? (
                <>
                  {" "}
                  instead of {estimate?.estimated ? "about " : ""}
                  {formatCents(baseline)} alone{estimate?.estimated ? " (estimated)" : ""} —{" "}
                  <strong className="text-savings">save {formatCents(baseline - quote)}</strong>
                </>
              ) : (
                <span className="text-warn">
                  {" "}
                  (no comparable single-purchase price for this amount)
                </span>
              )}
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={autoPay}
              onChange={(event) => setAutoPay(event.target.checked)}
            />
            <span>
              <strong>Pay my share automatically</strong> once the package is full. Nothing is
              charged before then.
            </span>
          </label>
          {message ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {message}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Joining…" : quote !== null ? `Join for ${formatCents(quote)}` : "Join"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Shareable invite link for members of an organizer-created group. */
export function InviteCard({ group }: { group: GroupView }) {
  const [copied, setCopied] = useState(false);
  if (!group.inviteCode) return null;
  const url =
    typeof window === "undefined"
      ? `/join/${group.inviteCode}`
      : `${window.location.origin}/join/${group.inviteCode}`;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-sunken p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <Link2 size={16} aria-hidden /> Invite link
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1 text-xs">
          {url}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(url).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted">
        Code {group.inviteCode} · works for shoppers in this demo session.
      </p>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong> <span className="text-muted">{hint}</span>
      </span>
    </label>
  );
}

const SETTABLE = new Set([
  "open",
  "awaiting_confirmation",
  "funding",
  "returning_contribution",
  "replacement_needed",
  "ready_to_purchase",
]);

/** Organizer automation settings and the member's own auto-pay preference. */
export function AutomationCard({ group, onUpdated }: { group: GroupView; onUpdated: Update }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const viewer = group.allocations.find(
    (row) => row.shopperId === group.viewer.shopperId && row.state === "active",
  );
  const isOrganizer = group.organizerShopperId === group.viewer.shopperId;
  if (!viewer || !SETTABLE.has(group.status)) return null;
  const canSetAutoPay = !viewer.contributionStatus || viewer.contributionStatus === "failed";

  async function save(path: "settings" | "autopay", body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      onUpdated(
        await api<GroupView>(`/api/groups/${group.id}/${path}`, {
          body: { expectedVersion: group.version, ...body },
        }),
      );
      announceRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>Automation</SectionTitle>
      {canSetAutoPay ? (
        <Toggle
          label="Pay my share automatically"
          hint={`(${formatCents(viewer.contributionCents)}) once everyone's terms are final.`}
          checked={viewer.autoPay}
          disabled={busy}
          onChange={(value) => void save("autopay", { enabled: value })}
        />
      ) : null}
      {isOrganizer ? (
        <>
          <Toggle
            label="Record the purchase automatically"
            hint="when every contribution is confirmed and the account reconciles."
            checked={group.autoPurchase}
            disabled={busy}
            onChange={(value) => void save("settings", { autoPurchase: value })}
          />
          <Toggle
            label="Find replacements automatically"
            hint="if someone leaves; their money is always returned first."
            checked={group.autoReplace}
            disabled={busy}
            onChange={(value) => void save("settings", { autoReplace: value })}
          />
          {group.origin === "organizer" ? (
            <Toggle
              label="List this group for nearby shoppers"
              hint="(otherwise only people with the invite link can join)."
              checked={group.visibility === "public"}
              disabled={busy}
              onChange={(value) =>
                void save("settings", { visibility: value ? "public" : "invite" })
              }
            />
          ) : null}
        </>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
