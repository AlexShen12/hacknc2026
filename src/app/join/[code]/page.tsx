import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getPageSession } from "@/server/page-session";
import { resolveInvite } from "@/server/services/group-builder-service";

/** Invite links resolve within the current demo session, then open the group with the code. */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const current = await getPageSession();
  if (!current) redirect("/");
  const { code } = await params;
  const groupId = await resolveInvite(current.session, code).catch(() => null);
  if (groupId) redirect(`/groups/${groupId}?invite=${encodeURIComponent(code.toUpperCase())}`);
  return (
    <Card className="flex flex-col gap-2">
      <h1 className="text-xl font-bold">Invite not found</h1>
      <p className="text-muted">
        This invite link isn&apos;t valid in your current demo session. Invite links work for the
        shoppers in the session where the group was created.
      </p>
      <Link href="/shop" className="font-semibold text-savings hover:underline">
        Back to shopping
      </Link>
    </Card>
  );
}
