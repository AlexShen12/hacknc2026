import { redirect } from "next/navigation";
import { GroupDetail } from "@/components/group-detail";
import { getPageSession } from "@/server/page-session";
import { providersFor } from "@/server/providers";
import { getGroupView } from "@/server/services/read-service";

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await getPageSession();
  if (!current) redirect("/");
  const { id } = await params;
  const group = await getGroupView(
    providersFor(current.session.mode),
    current.session,
    id,
    current.session.selectedShopperId,
  ).catch(() => null);
  if (!group) redirect("/shop");
  return <GroupDetail initial={group} mode={current.view.mode} />;
}
