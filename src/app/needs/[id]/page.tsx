import { redirect } from "next/navigation";
import { MatchResults } from "@/components/match-results";
import { getPageSession } from "@/server/page-session";
import { getNeed, listOffers, toNeedView } from "@/server/services/need-service";

export default async function NeedPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await getPageSession();
  if (!current) redirect("/");
  const { id } = await params;
  const need = await getNeed(current.session.id, id).catch(() => null);
  if (!need) redirect("/shop");
  if (need.status === "reserved" && need.reservedGroupId)
    redirect(`/groups/${need.reservedGroupId}`);
  const offers = await listOffers(current.session.id);
  const offer = offers.find((item) => item.id === need.acceptedOfferIds[0]);
  const owner = current.view.shoppers.find((shopper) => shopper.id === need.shopperId);
  return (
    <MatchResults
      need={toNeedView(need)}
      offer={offer ?? null}
      ownerName={owner?.displayName ?? "this shopper"}
      isOwner={need.shopperId === current.view.selectedShopperId}
      mode={current.view.mode}
    />
  );
}
