import { Crown, UserPlus } from "lucide-react";
import { OperationStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { hasLeft } from "@/domain/types";
import { formatCents } from "@/lib/format";
import type { AllocationView, GroupView } from "@/lib/view-types";

/** Quantity split, contribution and savings per member; amounts come straight from domain output. */
export function AllocationTable({
  group,
  showFunding = false,
}: {
  group: GroupView;
  showFunding?: boolean;
}) {
  const rows = showFunding
    ? group.allocations
    : group.allocations.filter((row) => !hasLeft(row.state));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <caption className="sr-only">Shares of the {group.offer.productName} package</caption>
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="py-2 pr-3">
              Shopper
            </th>
            <th scope="col" className="py-2 pr-3">
              Share
            </th>
            <th scope="col" className="py-2 pr-3">
              Pays
            </th>
            <th scope="col" className="py-2 pr-3">
              Alone
            </th>
            <th scope="col" className="py-2 pr-3">
              Saves
            </th>
            {showFunding ? (
              <>
                <th scope="col" className="py-2 pr-3">
                  Terms
                </th>
                <th scope="col" className="py-2 pr-3">
                  Contribution
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={
                hasLeft(row.state) ? "border-t border-line text-muted" : "border-t border-line"
              }
            >
              <th scope="row" className="py-2.5 pr-3 font-semibold">
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.name}
                  {row.shopperId === group.viewer.shopperId ? (
                    <Badge tone="savings">You</Badge>
                  ) : null}
                  {row.isOrganizer ? (
                    <Badge icon={<Crown size={12} aria-hidden />}>Organizer</Badge>
                  ) : null}
                  {row.isReplacement ? (
                    <Badge tone="info" icon={<UserPlus size={12} aria-hidden />}>
                      Replacement
                    </Badge>
                  ) : null}
                </span>
              </th>
              <td className="py-2.5 pr-3">
                {row.quantity} {group.offer.unit}
              </td>
              <td className="py-2.5 pr-3 font-semibold">{formatCents(row.contributionCents)}</td>
              <td className="py-2.5 pr-3 text-muted">
                <span className="line-through decoration-muted/50">
                  {row.baselineEstimated ? "≈ " : ""}
                  {formatCents(row.baselineCents)}
                </span>
                {row.baselineEstimated ? (
                  <span
                    className="ml-1 text-xs"
                    title="Estimated from the closest known package sizes"
                  >
                    est.
                  </span>
                ) : null}
              </td>
              <td className="py-2.5 pr-3 font-semibold text-savings">
                {formatCents(row.savingsCents)}
              </td>
              {showFunding ? (
                <>
                  <td className="py-2.5 pr-3">{termsLabel(row)}</td>
                  <td className="py-2.5 pr-3">{fundingCell(row)}</td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function termsLabel(row: AllocationView) {
  if (row.state === "released") return <Badge>Left before it filled</Badge>;
  if (row.state === "departed") return <Badge>Left the group</Badge>;
  if (row.state === "departing") return <Badge tone="warn">Leaving</Badge>;
  if (row.state === "picked_up") return <Badge tone="savings">Picked up</Badge>;
  return row.consented ? (
    <Badge tone="savings">Confirmed</Badge>
  ) : (
    <Badge tone="info">Not yet confirmed</Badge>
  );
}

function fundingCell(row: AllocationView) {
  if (row.returnStatus) {
    return (
      <span className="flex flex-col gap-1">
        <OperationStatusBadge
          status={row.returnStatus}
          label={`Return ${row.returnStatus === "confirmed" ? "confirmed" : row.returnStatus}`}
        />
        <span className="text-xs text-muted">Net {formatCents(row.netContributionCents)}</span>
      </span>
    );
  }
  if (!row.contributionStatus)
    return <span className="text-muted">{row.consented ? "Pledged" : "—"}</span>;
  return <OperationStatusBadge status={row.contributionStatus} />;
}
