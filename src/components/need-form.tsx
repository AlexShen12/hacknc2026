"use client";

import { Search, Sparkles, Users } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { OpenGroupCard } from "@/components/open-group-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { estimateBaseline } from "@/domain/baseline";
import type { Membership } from "@/domain/types";
import { ApiError, api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { formatCents, MEMBERSHIP_LABELS } from "@/lib/format";
import type { GroupView, NeedView, OfferView, SessionView } from "@/lib/view-types";

interface Draft {
  offerId: string;
  quantity: number;
  maxContributionCents: number;
  pickupWindow: string;
}

const FAMILY_LABELS: Record<string, string> = {
  "paper-towels": "Paper towels",
  "snack-bars": "Snack bars",
  "trash-bags": "Trash bags",
};

export function NeedForm({
  offers,
  pickupWindows,
  draft,
  memberships,
}: {
  offers: OfferView[];
  pickupWindows: SessionView["pickupWindows"];
  draft: Draft | null;
  memberships: Membership[];
}) {
  const router = useRouter();
  const [offerId, setOfferId] = useState(draft?.offerId || offers[0]?.id || "");
  const [quantity, setQuantity] = useState(String(draft?.quantity ?? ""));
  const [maxContribution, setMaxContribution] = useState(
    draft ? (draft.maxContributionCents / 100).toFixed(2) : "",
  );
  const [pickupWindow, setPickupWindow] = useState(
    draft?.pickupWindow ?? pickupWindows[0]?.key ?? "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<"find" | "start">("find");
  const [visibility, setVisibility] = useState<"public" | "invite">("public");
  const [autoPay, setAutoPay] = useState(true);
  const [autoPurchase, setAutoPurchase] = useState(true);
  const [openGroups, setOpenGroups] = useState<GroupView[]>([]);
  const [description, setDescription] = useState("");
  const [parsing, setParsing] = useState(false);
  const [filled, setFilled] = useState<Set<string>>(new Set());
  const [parseNote, setParseNote] = useState<string | null>(null);

  async function describe(event: FormEvent) {
    event.preventDefault();
    if (!description.trim()) return;
    setParsing(true);
    setParseNote(null);
    try {
      const draft = await api<{
        offerId: string | null;
        quantity: number | null;
        maxContribution: string | null;
        pickupWindow: string | null;
        source: "parser";
      }>("/api/needs/parse", { body: { text: description } });
      const changed = new Set<string>();
      if (draft.offerId) {
        setOfferId(draft.offerId);
        changed.add("offer");
      }
      if (draft.quantity !== null) {
        setQuantity(String(draft.quantity));
        changed.add("quantity");
      }
      if (draft.maxContribution !== null) {
        setMaxContribution(draft.maxContribution);
        changed.add("max");
      }
      const chosen = offers.find((item) => item.id === (draft.offerId ?? offerId));
      if (draft.pickupWindow) {
        setPickupWindow(draft.pickupWindow);
        changed.add("pickup");
      } else if (chosen && !chosen.pickupWindows.includes(pickupWindow)) {
        setPickupWindow(chosen.pickupWindows[0] ?? "");
      }
      setFilled(changed);
      setParseNote(
        changed.size === 0
          ? "We couldn't pick out a product, amount or budget. Try mentioning one, or fill in the form."
          : `Filled ${changed.size} field${changed.size === 1 ? "" : "s"} from your words. Check them before submitting.`,
      );
    } catch (error) {
      setParseNote(
        error instanceof Error ? error.message : "Couldn't read that. Fill in the form instead.",
      );
    } finally {
      setParsing(false);
    }
  }

  useEffect(() => {
    if (!offerId) return;
    let cancelled = false;
    api<GroupView[]>(`/api/groups/open?offerId=${encodeURIComponent(offerId)}`)
      .then((rows) => {
        if (!cancelled) setOpenGroups(rows);
      })
      .catch(() => {
        if (!cancelled) setOpenGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [offerId]);

  const offer = offers.find((item) => item.id === offerId);
  const families = useMemo(() => {
    const map = new Map<string, OfferView[]>();
    for (const item of offers)
      map.set(item.productFamily, [...(map.get(item.productFamily) ?? []), item]);
    return [...map.entries()];
  }, [offers]);
  const windows = pickupWindows.filter((window) => offer?.pickupWindows.includes(window.key));
  const baseline = offer ? estimateBaseline(offer.baselines, Number(quantity)) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setMessage(null);
    try {
      if (mode === "start") {
        const group = await api<GroupView>("/api/groups", {
          body: {
            offerId,
            quantity: Number(quantity),
            maxContribution,
            pickupWindow,
            visibility,
            autoPay,
            autoPurchase,
          },
        });
        router.push(`/groups/${group.id}`);
        return;
      }
      const need = await api<NeedView>("/api/needs", {
        body: { offerId, quantity: Number(quantity), maxContribution, pickupWindow },
      });
      router.push(`/needs/${need.id}`);
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fields ?? {});
        setMessage(error.message);
        if (error.code === "NEED_UNAVAILABLE" && typeof error.details?.groupId === "string") {
          router.push(`/groups/${error.details.groupId}`);
        }
      } else setMessage("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={describe}
        className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4"
      >
        <label htmlFor="describe" className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles size={16} aria-hidden className="text-savings" /> Describe what you need
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="describe"
            value={description}
            maxLength={300}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. about 5 rolls of paper towels, under $20, Sunday pickup"
            className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 py-2"
          />
          <Button type="submit" variant="secondary" disabled={parsing || !description.trim()}>
            {parsing ? "Reading…" : "Fill the form"}
          </Button>
        </div>
        {parseNote ? (
          <p role="status" className="text-sm text-muted">
            {parseNote}
          </p>
        ) : null}
      </form>
      <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <fieldset className="flex flex-col gap-5">
          <legend className="mb-3">
            <SectionTitle>1. Choose a product</SectionTitle>
          </legend>
          {families.map(([family, items]) => (
            <div key={family} className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-muted">{FAMILY_LABELS[family] ?? family}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {items.map((item) => {
                  const selected = item.id === offerId;
                  const eligible =
                    !item.membershipRequired || memberships.includes(item.membershipRequired);
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        "flex cursor-pointer gap-3 rounded-2xl border bg-surface p-3 transition-colors",
                        selected
                          ? "border-savings ring-2 ring-savings/30"
                          : "border-line hover:border-savings/40",
                      )}
                    >
                      <input
                        type="radio"
                        name="offer"
                        value={item.id}
                        checked={selected}
                        onChange={() => {
                          setOfferId(item.id);
                          if (!item.pickupWindows.includes(pickupWindow))
                            setPickupWindow(item.pickupWindows[0] ?? "");
                        }}
                        className="sr-only"
                      />
                      <Image
                        src={item.image}
                        alt=""
                        width={56}
                        height={56}
                        className="size-14 shrink-0 rounded-xl"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-bold">{item.retailerLabel}</span>
                        <span className="text-sm">{item.productName}</span>
                        <span className="text-xs text-muted">
                          {item.packageQuantity} {item.unit} · {formatCents(item.totalCents)}
                        </span>
                        {item.membershipRequired ? (
                          <span className="text-xs text-muted">
                            Needs a {MEMBERSHIP_LABELS[item.membershipRequired]} organizer
                            {eligible ? " (you qualify)" : ""}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </fieldset>

        {offer ? (
          <Card className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>2. Your share</SectionTitle>
              <Badge>{offer.sourceLabel}</Badge>
            </div>
            <fieldset className="grid gap-2 rounded-2xl bg-sunken p-1 sm:grid-cols-2">
              <legend className="sr-only">How do you want to buy?</legend>
              {(
                [
                  ["find", "Find me a group", "We match you with neighbors who need the rest."],
                  ["start", "Start my own group", "Open a group others can join or you can share."],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    "cursor-pointer rounded-xl px-3 py-2 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-savings",
                    mode === value ? "bg-surface shadow-sm ring-1 ring-savings/40" : "text-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="buy-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="sr-only"
                  />
                  <span className="block text-sm font-bold">{label}</span>
                  <span className="block text-xs">{hint}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={`How many ${offer.unit}?`} error={errors.quantity} htmlFor="quantity">
                <input
                  id="quantity"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={offer.packageQuantity - 1}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  className={cn(
                    "w-full rounded-xl border border-line bg-surface px-3 py-2",
                    filled.has("quantity") && "ring-2 ring-savings/50",
                  )}
                  aria-describedby="quantity-help"
                />
                <span id="quantity-help" className="text-xs text-muted">
                  Package has {offer.packageQuantity}. Known prices for{" "}
                  {offer.baselines.map((item) => item.quantity).join(", ")}; other amounts are
                  estimated from the closest ones.
                </span>
              </Field>
              <Field label="Most you'll contribute" error={errors.maxContribution} htmlFor="max">
                <div
                  className={cn(
                    "flex items-center rounded-xl border border-line bg-surface px-3",
                    filled.has("max") && "ring-2 ring-savings/50",
                  )}
                >
                  <span className="text-muted" aria-hidden>
                    $
                  </span>
                  <input
                    id="max"
                    inputMode="decimal"
                    value={maxContribution}
                    onChange={(event) => setMaxContribution(event.target.value)}
                    className="w-full bg-transparent px-1 py-2 outline-none"
                  />
                </div>
              </Field>
              <Field label="Pickup slot" error={errors.pickupWindow} htmlFor="pickup">
                <select
                  id="pickup"
                  value={pickupWindow}
                  onChange={(event) => setPickupWindow(event.target.value)}
                  className={cn(
                    "w-full rounded-xl border border-line bg-surface px-3 py-2",
                    filled.has("pickup") && "ring-2 ring-savings/50",
                  )}
                >
                  {windows.map((window) => (
                    <option key={window.key} value={window.key}>
                      {window.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {offer && baseline ? (
              <p className="text-sm text-muted">
                Buying {quantity} {offer.unit} on your own costs{" "}
                {baseline.estimated ? "about " : ""}
                <strong className="text-ink">{formatCents(baseline.baselineCents)}</strong>
                {baseline.estimated ? (
                  <>
                    {" "}
                    <Badge tone="info">estimated</Badge> from the {baseline.basis.join("- and ")}-
                    {offer.unit.replace(/s$/, "")} prices
                  </>
                ) : (
                  " (fixture comparison price)"
                )}
                .
              </p>
            ) : null}
            {mode === "start" ? (
              <fieldset className="flex flex-col gap-3 rounded-2xl border border-line p-4">
                <legend className="px-1 text-sm font-semibold">Group options</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === "public"}
                      onChange={() => setVisibility("public")}
                    />
                    List it for nearby shoppers
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === "invite"}
                      onChange={() => setVisibility("invite")}
                    />
                    Invite only (share a link)
                  </label>
                </div>
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
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={autoPurchase}
                    onChange={(event) => setAutoPurchase(event.target.checked)}
                  />
                  <span>
                    <strong>Record the purchase automatically</strong> as soon as everyone&apos;s
                    money is confirmed.
                  </span>
                </label>
              </fieldset>
            ) : null}
            {message ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {message}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={submitting}>
                {mode === "start" ? (
                  <Users size={18} aria-hidden />
                ) : (
                  <Search size={18} aria-hidden />
                )}
                {submitting
                  ? mode === "start"
                    ? "Opening your group…"
                    : "Finding neighbors…"
                  : mode === "start"
                    ? "Start my group"
                    : "Find my group"}
              </Button>
            </div>
          </Card>
        ) : null}

        {offer && openGroups.length > 0 ? (
          <section className="flex flex-col gap-3" aria-labelledby="open-groups-title">
            <SectionTitle id="open-groups-title">Open groups for this product</SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              {openGroups.map((group) => (
                <OpenGroupCard key={group.id} group={group} />
              ))}
            </div>
          </section>
        ) : null}
      </form>
    </div>
  );
}

function Field({
  label,
  error,
  htmlFor,
  children,
}: {
  label: string;
  error?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-sm font-medium text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
