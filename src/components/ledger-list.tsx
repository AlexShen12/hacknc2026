import { ArrowDownLeft, ArrowUpRight, CircleAlert, CircleHelp, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { OperationStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/format";
import type { LedgerEntryView } from "@/lib/view-types";

const KIND: Record<LedgerEntryView["kind"], string> = {
  contribution: "Contribution",
  return: "Returned contribution",
  purchase: "Merchant purchase",
  deposit: "Top-up",
  bill_payment: "Bill payment",
};

const when = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function CheckBadge({ entry, bankLabel }: { entry: LedgerEntryView; bankLabel: string }) {
  switch (entry.check) {
    case "verified":
      return (
        <Badge tone="savings" icon={<ShieldCheck size={12} aria-hidden />}>
          Verified with {bankLabel}
        </Badge>
      );
    case "mismatch":
    case "missing":
      return (
        <Badge tone="danger" icon={<CircleAlert size={12} aria-hidden />}>
          {entry.check === "missing" ? "Not found at bank" : "Doesn't match bank"}
        </Badge>
      );
    case "unavailable":
      return (
        <Badge tone="warn" icon={<CircleHelp size={12} aria-hidden />}>
          Bank check unavailable
        </Badge>
      );
    default:
      return <OperationStatusBadge status={entry.status} />;
  }
}

/** Money movements for one account, each with the bank's own record reference. */
export function LedgerList({
  entries,
  bankLabel,
}: {
  entries: LedgerEntryView[];
  bankLabel: string;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted">No money has moved yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-line">
      {entries.map((entry) => (
        <li
          key={entry.operationId}
          className="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={
                entry.direction === "in"
                  ? "mt-0.5 rounded-full bg-savings-soft p-1.5 text-savings"
                  : "mt-0.5 rounded-full bg-sunken p-1.5 text-muted"
              }
            >
              {entry.direction === "in" ? (
                <ArrowDownLeft size={16} aria-label="Money in" />
              ) : (
                <ArrowUpRight size={16} aria-label="Money out" />
              )}
            </span>
            <div className="min-w-0">
              <p className="font-semibold">
                {KIND[entry.kind]}
                {entry.shopperName ? ` · ${entry.shopperName}` : ""}
                {entry.groupId ? (
                  <>
                    {" · "}
                    <Link href={`/groups/${entry.groupId}`} className="text-savings hover:underline">
                      {entry.label}
                    </Link>
                  </>
                ) : null}
              </p>
              <p className="text-xs text-muted">
                {when.format(new Date(entry.createdAt))} ·{" "}
                {entry.providerId
                  ? `${bankLabel} record ${entry.providerId.slice(0, 8)}…${entry.providerStatus ? ` (${entry.providerStatus})` : ""}`
                  : "No bank record yet"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={entry.direction === "in" ? "font-bold text-savings" : "font-bold"}>
              {entry.direction === "in" ? "+" : "−"}
              {formatCents(entry.amountCents)}
            </span>
            <CheckBadge entry={entry} bankLabel={bankLabel} />
          </div>
        </li>
      ))}
    </ul>
  );
}
