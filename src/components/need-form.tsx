"use client";

import { Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import type { Membership } from "@/domain/types";
import { ApiError, api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { formatCents, MEMBERSHIP_LABELS } from "@/lib/format";
import type { NeedView, OfferView, SessionView } from "@/lib/view-types";

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

  const offer = offers.find((item) => item.id === offerId);
  const families = useMemo(() => {
    const map = new Map<string, OfferView[]>();
    for (const item of offers)
      map.set(item.productFamily, [...(map.get(item.productFamily) ?? []), item]);
    return [...map.entries()];
  }, [offers]);
  const windows = pickupWindows.filter((window) => offer?.pickupWindows.includes(window.key));
  const baseline = offer?.baselines.find((item) => item.quantity === Number(quantity));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setMessage(null);
    try {
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
                className="w-full rounded-xl border border-line bg-surface px-3 py-2"
                aria-describedby="quantity-help"
              />
              <span id="quantity-help" className="text-xs text-muted">
                Package has {offer.packageQuantity}. Comparable amounts:{" "}
                {offer.baselines.map((item) => item.quantity).join(", ")}.
              </span>
            </Field>
            <Field label="Most you'll contribute" error={errors.maxContribution} htmlFor="max">
              <div className="flex items-center rounded-xl border border-line bg-surface px-3">
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
                className="w-full rounded-xl border border-line bg-surface px-3 py-2"
              >
                {windows.map((window) => (
                  <option key={window.key} value={window.key}>
                    {window.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {baseline ? (
            <p className="text-sm text-muted">
              Buying {baseline.quantity} {offer.unit} on your own costs about{" "}
              <strong className="text-ink">{formatCents(baseline.baselineCents)}</strong> (fixture
              comparison price).
            </p>
          ) : quantity ? (
            <p className="text-sm text-warn">
              There is no comparable single-purchase price for {quantity} {offer.unit}, so savings
              can&apos;t be shown for that amount.
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {message}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={submitting}>
              <Search size={18} aria-hidden />
              {submitting ? "Finding neighbors…" : "Find my group"}
            </Button>
          </div>
        </Card>
      ) : null}
    </form>
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
