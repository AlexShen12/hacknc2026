import { ArrowRight, Users } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { hasLeft } from "@/domain/types";
import { formatCents } from "@/lib/format";
import type { GroupView } from "@/lib/view-types";

/** Summary of a listed group someone can join, with how much of the package is still open. */
export function OpenGroupCard({ group }: { group: GroupView }) {
  const members = group.allocations.filter((row) => !hasLeft(row.state));
  const claimed = group.offer.packageQuantity - group.remainingUnits;
  const progress = Math.round((claimed / group.offer.packageQuantity) * 100);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold">
            {group.offer.retailerLabel} {group.offer.productName}
          </p>
          <p className="text-sm text-muted">
            Organized by {group.organizerName ?? "a neighbor"} · Pickup {group.pickupLabel}
          </p>
        </div>
        <Badge tone="info" icon={<Users size={12} aria-hidden />}>
          {members.length} {members.length === 1 ? "member" : "members"}
        </Badge>
      </div>
      <div>
        <div
          className="h-2 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={group.offer.packageQuantity}
          aria-valuenow={claimed}
          aria-label="Units claimed"
        >
          <div className="h-full rounded-full bg-savings" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-1 text-sm">
          {group.joinSlot?.mode === "slot" ? (
            <>
              One open share:{" "}
              <strong>
                {group.joinSlot.quantity} {group.offer.unit}
              </strong>{" "}
              for {formatCents(group.joinSlot.contributionCents)}
            </>
          ) : (
            <>
              <strong>
                {group.remainingUnits} of {group.offer.packageQuantity} {group.offer.unit}
              </strong>{" "}
              still available · package {formatCents(group.offer.totalCents)}
            </>
          )}
        </p>
      </div>
      <Link
        href={`/groups/${group.id}`}
        className="inline-flex items-center gap-1 self-start text-sm font-semibold text-savings hover:underline"
      >
        View and join <ArrowRight size={16} aria-hidden />
      </Link>
    </Card>
  );
}
