import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NeedForm } from "@/components/need-form";
import { GroupStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, SectionTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { getPageSession } from "@/server/page-session";
import { listNeedsForShopper, listOffers } from "@/server/services/need-service";
import { listGroupsForShopper } from "@/server/services/read-service";

const NEED_STATUS: Record<string, string> = {
  forming: "Looking for a group",
  reserved: "In a group",
  withdrawn: "Withdrawn",
  fulfilled: "Fulfilled",
};

export default async function ShopPage() {
  const current = await getPageSession();
  if (!current) redirect("/");
  const { session, view } = current;
  const shopper = view.shoppers.find((item) => item.id === view.selectedShopperId);
  if (!shopper) redirect("/");
  const [offers, needs, groups] = await Promise.all([
    listOffers(session.id),
    listNeedsForShopper(session.id, shopper.id),
    listGroupsForShopper(session, shopper.id),
  ]);
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const openNeed = needs.find((need) => need.status === "forming");
  const draft = openNeed
    ? {
        offerId: openNeed.offerIds[0] ?? "",
        quantity: openNeed.quantity,
        maxContributionCents: openNeed.maxContributionCents,
        pickupWindow: openNeed.pickupWindow,
      }
    : shopper.draftNeed
      ? {
          offerId: offers.find((offer) => offer.offerKey === shopper.draftNeed?.offerKey)?.id ?? "",
          quantity: shopper.draftNeed.quantity,
          maxContributionCents: shopper.draftNeed.maxContributionCents,
          pickupWindow: shopper.draftNeed.pickupWindow,
        }
      : null;

  return (
    <div className="flex flex-col gap-10">
      <div>
        <p className="text-sm font-semibold text-savings">Hi {shopper.displayName}</p>
        <h1 className="text-3xl font-extrabold tracking-tight">What do you need this week?</h1>
        <p className="mt-1 text-muted">
          Pick a product, the exact amount you&apos;ll use and the most you want to spend. Pickup is
          at {view.pickupZone.label}.
        </p>
      </div>

      {groups.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="groups-title">
          <SectionTitle id="groups-title">Your groups</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2">
            {groups.map((group) => {
              const mine = group.allocations.find((row) => row.shopperId === shopper.id);
              return (
                <Link key={group.id} href={`/groups/${group.id}`} className="group">
                  <Card className="flex h-full flex-col gap-2 group-hover:border-savings/50">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-bold">
                        {group.offer.retailerLabel} {group.offer.productName}
                      </p>
                      <GroupStatusBadge status={group.status} />
                    </div>
                    {mine ? (
                      <p className="text-sm text-muted">
                        Your share: {mine.quantity} {group.offer.unit} for{" "}
                        {formatCents(mine.contributionCents)}{" "}
                        <span className="font-semibold text-savings">
                          (save {formatCents(mine.savingsCents)})
                        </span>
                      </p>
                    ) : null}
                    <span className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-savings">
                      Open group <ArrowRight size={16} aria-hidden />
                    </span>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <NeedForm
        offers={offers}
        pickupWindows={view.pickupWindows}
        draft={draft}
        memberships={shopper.memberships}
        key={shopper.id}
      />

      {needs.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="needs-title">
          <SectionTitle id="needs-title">Your requests</SectionTitle>
          <ul className="flex flex-col gap-2">
            {needs.map((need) => {
              const offer = offerById.get(need.offerIds[0] ?? "");
              return (
                <li key={need.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-semibold">
                        {need.quantity} {offer?.unit} · {offer?.retailerLabel} {offer?.productName}
                      </p>
                      <p className="text-sm text-muted">
                        Up to {formatCents(need.maxContributionCents)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge tone={need.status === "forming" ? "info" : "neutral"}>
                        {NEED_STATUS[need.status]}
                      </Badge>
                      {need.status === "forming" ? (
                        <Link
                          href={`/needs/${need.id}`}
                          className="text-sm font-semibold text-savings hover:underline"
                        >
                          Find a group
                        </Link>
                      ) : need.groupId ? (
                        <Link
                          href={`/groups/${need.groupId}`}
                          className="text-sm font-semibold text-savings hover:underline"
                        >
                          View group
                        </Link>
                      ) : null}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
