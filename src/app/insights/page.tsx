import { Database, Sparkles, Store } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BarList } from "@/components/bar-list";
import { GroupStatusBadge } from "@/components/status";
import { Card, SectionTitle } from "@/components/ui/card";
import { GROUP_STATUSES, type GroupStatus } from "@/domain/types";
import { formatCents } from "@/lib/format";
import { getPageSession } from "@/server/page-session";
import { providersFor } from "@/server/providers";
import { getInsights } from "@/server/services/insights-service";

export const dynamic = "force-dynamic";

function isStatus(value: string): value is GroupStatus {
  return (GROUP_STATUSES as readonly string[]).includes(value);
}

export default async function InsightsPage() {
  const current = await getPageSession();
  if (!current) redirect("/");
  const insights = await getInsights(providersFor(current.session.mode), current.session).catch(
    (error: unknown) => (error instanceof Error ? error.message : "Insights unavailable."),
  );
  if (typeof insights === "string") {
    return (
      <Card role="alert" className="flex flex-col gap-2">
        <p className="font-semibold text-danger">Community insights are unavailable right now.</p>
        <p className="text-sm text-muted">
          {insights} This is a temporary analytics problem; nothing about your groups or money
          changed. Reload to try again.
        </p>
      </Card>
    );
  }
  const { totals } = insights;
  const tiles = [
    { label: "Saved by shopping together", value: formatCents(totals.savingsCents), accent: true },
    {
      label: "Groups completed",
      value: `${totals.completedGroups} of ${totals.groupsFormed}`,
      detail: `${totals.fillRatePercent}% reached purchase`,
    },
    {
      label: "Shoppers served",
      value: String(totals.shoppersServed),
      detail: `${totals.unitsShared} units shared`,
    },
    {
      label: "Open requests",
      value: String(totals.openNeeds),
      detail: `could fill ${totals.fillablePackages} more package${totals.fillablePackages === 1 ? "" : "s"}`,
    },
  ];
  const money = [
    { label: "Contributions confirmed", value: totals.collectedCents },
    { label: "Returned to shoppers who left", value: totals.returnedCents },
    { label: "Merchant purchases recorded", value: totals.purchasedCents },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-savings">Community insights</p>
          <h1 className="text-3xl font-extrabold tracking-tight">How buying together is going</h1>
          <p className="text-muted">
            Everyone in this demo session, updated each time you open this page.
          </p>
        </div>
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Database size={16} aria-hidden />
          Live SQL on {insights.engine}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className={tile.accent ? "bg-savings-soft" : undefined}>
            <p className="text-sm text-muted">{tile.label}</p>
            <p
              className={
                tile.accent
                  ? "text-3xl font-extrabold text-savings-strong"
                  : "text-3xl font-extrabold"
              }
            >
              {tile.value}
            </p>
            {tile.detail ? <p className="text-xs text-muted">{tile.detail}</p> : null}
          </Card>
        ))}
      </div>

      <Card className="flex flex-col gap-2 border-savings/20">
        <p className="flex items-center gap-1.5 text-sm font-bold text-savings-strong">
          <Sparkles size={16} aria-hidden /> Highlights
          <span className="font-normal text-muted">· written from the numbers below</span>
        </p>
        <p className="leading-relaxed">{insights.summary.text}</p>
        <p className="text-xs text-muted">
          Numbers on this page come from the queries, not from the summary.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <SectionTitle>Savings by product</SectionTitle>
          {insights.savings.length === 0 ? (
            <p className="text-sm text-muted">
              Savings appear here once a group records its purchase.
            </p>
          ) : (
            <BarList
              tone="savings"
              caption="Savings by product from completed groups"
              data={insights.savings.map((row) => ({
                key: row.offerId,
                label: `${row.retailerLabel} ${row.productName}`,
                value: row.savingsCents,
                valueLabel: formatCents(row.savingsCents),
                description: `${row.retailerLabel} ${row.productName}: ${formatCents(row.savingsCents)} saved by ${row.shoppers} shoppers in ${row.groups} group${row.groups === 1 ? "" : "s"} (${row.units} units)`,
              }))}
            />
          )}
        </Card>

        <Card className="flex flex-col gap-3">
          <SectionTitle>Open demand by product and pickup</SectionTitle>
          {insights.demand.length === 0 ? (
            <p className="text-sm text-muted">No open requests right now.</p>
          ) : (
            <>
              <BarList
                tone="demand"
                caption="Units requested by open requests, with the package size marked"
                data={insights.demand.map((row) => ({
                  key: `${row.offerId}-${row.pickupLabel}`,
                  label: (
                    <>
                      {row.retailerLabel} {row.productName}{" "}
                      <span className="text-muted">· {row.pickupLabel}</span>
                    </>
                  ),
                  value: row.requestedUnits,
                  reference: row.packageQuantity,
                  valueLabel: `${row.requestedUnits} of ${row.packageQuantity}`,
                  description: `${row.retailerLabel} ${row.productName}, ${row.pickupLabel}: ${row.openNeeds} open requests for ${row.requestedUnits} units; one package holds ${row.packageQuantity}`,
                }))}
              />
              <p className="text-xs text-muted">The dark tick marks one package&apos;s size.</p>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <SectionTitle>Group outcomes</SectionTitle>
          {insights.outcomes.length === 0 ? (
            <p className="text-sm text-muted">No groups yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {insights.outcomes.map((row) => (
                <li
                  key={`${row.status}-${row.origin}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex items-center gap-2">
                    {isStatus(row.status) ? <GroupStatusBadge status={row.status} /> : row.status}
                    <span className="text-muted">
                      {row.origin === "organizer" ? "started by a shopper" : "matched"}
                    </span>
                  </span>
                  <span>
                    <strong>{row.groups}</strong> · avg {row.averageMembers.toFixed(1)} members
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex flex-col gap-3">
          <SectionTitle>Money movements</SectionTitle>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {money.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-2 py-2">
                <span>{row.label}</span>
                <strong>{formatCents(row.value)}</strong>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Confirmed records only. See each one, verified with the bank, in your{" "}
            <Link href="/wallet" className="font-semibold text-savings hover:underline">
              wallet
            </Link>
            .
          </p>
        </Card>
      </div>

      <Card className="flex flex-col gap-3">
        <SectionTitle className="flex items-center gap-2">
          <Store size={20} aria-hidden /> Spending by store
        </SectionTitle>
        <p className="text-sm text-muted">
          Read back from {insights.bankLabel}&apos;s merchant records for each store, not from our own
          bookkeeping.
        </p>
        {insights.storeSpending.every((row) => row.purchases === 0) ? (
          <p className="text-sm text-muted">No purchases have been recorded at any store yet.</p>
        ) : (
          <BarList
            tone="demand"
            caption="Purchases recorded at each store's merchant account"
            data={insights.storeSpending.map((row) => ({
              key: row.storeName,
              label: row.storeName,
              value: row.amountCents,
              valueLabel: formatCents(row.amountCents),
              description: `${row.storeName}: ${row.purchases} purchase${row.purchases === 1 ? "" : "s"} totaling ${formatCents(row.amountCents)}`,
            }))}
          />
        )}
      </Card>

      <details className="rounded-2xl border border-line bg-surface p-4 text-sm">
        <summary className="cursor-pointer font-semibold">
          View the data as tables and query references
        </summary>
        <div className="mt-3 flex flex-col gap-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left">
            <caption className="mb-1 text-left font-semibold">Savings by product</caption>
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Groups</th>
                <th scope="col">Shoppers</th>
                <th scope="col">Units</th>
                <th scope="col">Saved</th>
              </tr>
            </thead>
            <tbody>
              {insights.savings.map((row) => (
                <tr key={row.offerId} className="border-t border-line">
                  <th scope="row" className="py-1 font-normal">
                    {row.retailerLabel} {row.productName}
                  </th>
                  <td>{row.groups}</td>
                  <td>{row.shoppers}</td>
                  <td>{row.units}</td>
                  <td>{formatCents(row.savingsCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full min-w-[480px] text-left">
            <caption className="mb-1 text-left font-semibold">Open demand</caption>
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Pickup</th>
                <th scope="col">Requests</th>
                <th scope="col">Units</th>
                <th scope="col">Package</th>
              </tr>
            </thead>
            <tbody>
              {insights.demand.map((row) => (
                <tr key={`${row.offerId}-${row.pickupLabel}`} className="border-t border-line">
                  <th scope="row" className="py-1 font-normal">
                    {row.retailerLabel} {row.productName}
                  </th>
                  <td>{row.pickupLabel}</td>
                  <td>{row.openNeeds}</td>
                  <td>{row.requestedUnits}</td>
                  <td>{row.packageQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted">
            Four SQL analyses ran directly on {insights.engine} at{" "}
            {new Date(insights.generatedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET,
            over the same records the app uses — no copy or sync step.
          </p>
        </div>
      </details>
    </div>
  );
}
