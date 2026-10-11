"use client";

import { ArrowRight, Database, RefreshCw, SearchX, UserX } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AllocationTable } from "@/components/allocation-table";
import { ExplanationCard } from "@/components/explanation-card";
import { OpenGroupCard } from "@/components/open-group-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { exclusionText } from "@/domain/explanation";
import type { ProviderMode } from "@/domain/types";
import { ApiError, api } from "@/lib/api-client";
import { formatCents } from "@/lib/format";
import type { MatchView, NeedView, OfferView } from "@/lib/view-types";

export function MatchResults({
  need,
  offer,
  ownerName,
  isOwner,
  mode,
}: {
  need: NeedView;
  offer: OfferView | null;
  ownerName: string;
  isOwner: boolean;
  mode: ProviderMode;
}) {
  const [result, setResult] = useState<MatchView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api<MatchView>("/api/matches", { body: { needId: need.id } }));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "NETWORK", "Search failed."));
    } finally {
      setLoading(false);
    }
  }, [need.id]);

  useEffect(() => {
    if (isOwner && !started.current) {
      started.current = true;
      void search();
    }
  }, [isOwner, search]);

  if (!isOwner) {
    return (
      <Card>
        <p>
          This request belongs to {ownerName}. Switch to {ownerName} in the header to search for
          their group.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-savings">Your request</p>
          <h1 className="text-3xl font-extrabold tracking-tight">
            {need.quantity} {offer?.unit} of {offer?.retailerLabel} {offer?.productName}
          </h1>
          <p className="text-muted">
            You&apos;ll contribute at most {formatCents(need.maxContributionCents)}.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void search()} disabled={loading}>
          <RefreshCw size={16} aria-hidden /> Search again
        </Button>
      </div>

      {loading && !result ? (
        <Card aria-live="polite">
          <p className="font-semibold">Finding neighbors who need the rest of the package…</p>
          <p className="text-sm text-muted">
            Searching open requests with the same product, pickup slot and a budget that fits.
          </p>
        </Card>
      ) : null}

      {error ? (
        <Card role="alert" className="border-danger/30">
          <p className="font-semibold text-danger">{error.message}</p>
          {error.code === "NEED_UNAVAILABLE" && typeof error.details?.groupId === "string" ? (
            <Link
              href={`/groups/${error.details.groupId}`}
              className="font-semibold text-savings hover:underline"
            >
              Go to your group
            </Link>
          ) : error.status === 503 ? (
            <p className="text-sm text-muted">
              This is a temporary provider problem. Try the search again.
            </p>
          ) : null}
        </Card>
      ) : null}

      {result ? (
        <>
          {result.groups.length === 0 ? (
            <Card className="flex gap-3">
              <SearchX className="shrink-0 text-muted" aria-hidden />
              <div>
                <p className="font-semibold">No group fits yet.</p>
                <p className="text-sm text-muted">
                  Nobody nearby needs exactly the rest of this package within their budget right
                  now. Your request stays open, and you can search again later.
                </p>
              </div>
            </Card>
          ) : (
            <section className="flex flex-col gap-4" aria-labelledby="proposals-title">
              <SectionTitle id="proposals-title">
                {result.groups.length === 1
                  ? "We found a group"
                  : `We found ${result.groups.length} groups`}
              </SectionTitle>
              {result.groups.map((group, index) => {
                const mine = group.allocations.find((row) => row.shopperId === need.shopperId);
                return (
                  <Card key={group.id} className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start gap-4">
                      <Image
                        src={group.offer.image}
                        alt=""
                        width={72}
                        height={72}
                        className="size-18 rounded-xl"
                      />
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="flex flex-wrap items-center gap-2">
                          {index === 0 ? <Badge tone="savings">Best match</Badge> : null}
                          <Badge>{group.offer.sourceLabel}</Badge>
                        </div>
                        <p className="mt-1 text-xl font-bold">
                          {group.offer.retailerLabel} {group.offer.productName}
                        </p>
                        <p className="text-sm text-muted">
                          {group.offer.packageQuantity} {group.offer.unit} for{" "}
                          {formatCents(group.offer.totalCents)} (includes{" "}
                          {formatCents(group.offer.taxCents)} demo tax and{" "}
                          {formatCents(group.offer.feeCents)} fees) · Pickup {group.pickupLabel}
                        </p>
                      </div>
                      {mine ? (
                        <div className="w-full rounded-xl bg-savings-soft px-4 py-3 sm:w-auto sm:text-right">
                          <p className="text-xs font-semibold text-savings-strong">You pay</p>
                          <p className="text-2xl font-extrabold">
                            {formatCents(mine.contributionCents)}
                          </p>
                          <p className="text-sm font-semibold text-savings">
                            save {formatCents(mine.savingsCents)}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    <ExplanationCard
                      groupId={group.id}
                      initial={group.explanation}
                    />
                    <AllocationTable group={group} />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm text-muted">
                        Organizer: <strong className="text-ink">{group.organizerName}</strong> ·
                        Group saves{" "}
                        <strong className="text-savings">
                          {formatCents(group.totalSavingsCents)}
                        </strong>
                      </p>
                      <Link
                        href={`/groups/${group.id}`}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-savings px-4 py-2.5 font-semibold text-white hover:bg-savings-strong"
                      >
                        Review and confirm <ArrowRight size={18} aria-hidden />
                      </Link>
                    </div>
                  </Card>
                );
              })}
            </section>
          )}

          {result.openGroups.length > 0 ? (
            <section className="flex flex-col gap-3" aria-labelledby="open-title">
              <SectionTitle id="open-title">Or join an open group</SectionTitle>
              <p className="text-sm text-muted">
                Neighbors started these groups for the same product and pickup slot, and your{" "}
                {need.quantity} {offer?.unit} fit within your limit.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {result.openGroups.map((group) => (
                  <OpenGroupCard key={group.id} group={group} />
                ))}
              </div>
            </section>
          ) : null}

          {result.exclusions.length > 0 ? (
            <section className="flex flex-col gap-3" aria-labelledby="excluded-title">
              <SectionTitle id="excluded-title">Who didn&apos;t fit, and why</SectionTitle>
              <ul className="flex flex-col gap-2">
                {result.exclusions.map((item) => (
                  <li key={`${item.name}-${item.offerId}-${item.reason}`}>
                    <Card className="flex items-center gap-3 py-3">
                      <UserX size={18} className="shrink-0 text-muted" aria-hidden />
                      <p className="text-sm">
                        <strong>{item.name}</strong> {exclusionText(item.reason)}
                        {item.reason === "over_budget" ||
                        item.reason === "insufficient_available_funds"
                          ? ` (share would be at least ${formatCents(item.minimumShareCents)})`
                          : ""}
                        .
                      </p>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-3" aria-labelledby="demand-title">
            <SectionTitle id="demand-title" className="flex items-center gap-2">
              <Database size={18} aria-hidden /> Demand snapshot
            </SectionTitle>
            <Card className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                Live SQL on {result.analytics.engine}, over every open request in this
                session.
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {result.demand.map((row) => (
                  <li key={row.offerId} className="rounded-xl bg-sunken px-3 py-2 text-sm">
                    <strong>
                      {row.retailerLabel} {row.productName}
                    </strong>
                    : {row.openNeeds} open requests for {row.requestedUnits} of{" "}
                    {row.packageQuantity} units
                    {row.fillablePackages > 0
                      ? ` — enough demand for ${row.fillablePackages} package(s)`
                      : ""}
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}
