import { and, asc, eq, ne, sql } from "drizzle-orm";
import { type ExplanationEvidence, templateExplanation } from "@/domain/explanation";
import { type InsightsEvidence, templateInsights } from "@/domain/insights";
import { localParseNeed, type ParseContext } from "@/domain/need-parse";
import type { Db } from "@/server/db/client";
import { allocations, bankOperations, groups, needs, offers } from "@/server/db/schema";
import type {
  AnalyticsProvider,
  CandidateQuery,
  InsightsRows,
} from "@/server/providers/analytics/types";

/**
 * Analytics over the operational Postgres database (Neon when deployed): candidate search, demand
 * and community insights run as SQL on the live records, and explanations, summaries and
 * plain-English parsing are deterministic code over verified numbers. Used by both modes.
 */
export class PostgresAnalyticsProvider implements AnalyticsProvider {
  readonly name = "postgres" as const;

  constructor(private readonly db: Db) {}


  async queryCandidates(query: CandidateQuery) {
    const rows = await this.db
      .select({ needId: needs.id, shopperId: needs.shopperId, entityVersion: needs.revision })
      .from(needs)
      .where(
        and(
          eq(needs.sessionId, query.sessionId),
          eq(needs.status, "forming"),
          sql`${needs.acceptedOfferIds} @> ${JSON.stringify([query.offerId])}::jsonb`,
          ne(needs.id, query.initiatingNeedId),
          ne(needs.shopperId, query.initiatingShopperId),
          eq(needs.pickupZone, query.pickupZone),
          eq(needs.pickupWindow, query.pickupWindow),
        ),
      )
      .orderBy(asc(needs.createdAt), asc(needs.id))
      .limit(query.limit);
    return { rows, queryId: null };
  }

  async demandSummary(sessionId: string) {
    const result = await this.db.execute<{
      offer_id: string;
      package_quantity: number;
      open_needs: string;
      requested_units: string;
    }>(sql`
      select o.id as offer_id, o.package_quantity,
             count(n.id) as open_needs, coalesce(sum(n.quantity), 0) as requested_units
      from ${offers} o
      left join ${needs} n
        on n.session_id = o.session_id and n.status = 'forming'
       and n.accepted_offer_ids @> jsonb_build_array(o.id)
      where o.session_id = ${sessionId}
      group by o.id, o.package_quantity
      order by requested_units desc, o.id
    `);
    return {
      rows: result.rows.map((row) => {
        const requestedUnits = Number(row.requested_units);
        return {
          offerId: row.offer_id,
          packageQuantity: row.package_quantity,
          openNeeds: Number(row.open_needs),
          requestedUnits,
          fillablePackages: Math.floor(requestedUnits / row.package_quantity),
        };
      }),
      queryId: null,
    };
  }

  async explain(evidence: ExplanationEvidence) {
    return { text: templateExplanation(evidence), requestId: null };
  }

  /** Four community analyses over the operational records. */
  async communityInsights(sessionId: string): Promise<InsightsRows> {
    const demand = await this.db.execute<{
      offer_id: string;
      product_name: string;
      retailer: string;
      pickup_window: string;
      package_quantity: number;
      open_needs: string;
      requested_units: string;
    }>(sql`
      select o.id as offer_id, o.product_name, o.retailer, n.pickup_window, o.package_quantity,
             count(n.id) as open_needs, sum(n.quantity) as requested_units
      from ${offers} o
      join ${needs} n on n.session_id = o.session_id and n.status = 'forming'
       and n.accepted_offer_ids @> jsonb_build_array(o.id)
      where o.session_id = ${sessionId}
      group by o.id, o.product_name, o.retailer, n.pickup_window, o.package_quantity
      order by requested_units desc, o.id, n.pickup_window
    `);
    const outcomes = await this.db.execute<{
      status: string;
      origin: string;
      groups: string;
      avg_members: string;
      savings_cents: string;
    }>(sql`
      select g.status, g.origin, count(*) as groups, avg(m.members) as avg_members,
             coalesce(sum(m.savings), 0) as savings_cents
      from ${groups} g
      left join lateral (
        select count(*) as members, coalesce(sum(a.savings_cents), 0) as savings
        from ${allocations} a where a.group_id = g.id and a.state not in ('departed', 'released')
      ) m on true
      where g.session_id = ${sessionId} and coalesce(g.status_reason, '') <> 'superseded'
      group by g.status, g.origin
      order by groups desc, g.status
    `);
    const savings = await this.db.execute<{
      offer_id: string;
      product_name: string;
      retailer: string;
      groups: string;
      shoppers: string;
      units: string;
      savings_cents: string;
    }>(sql`
      select o.id as offer_id, o.product_name, o.retailer,
             count(distinct g.id) as groups, count(*) as shoppers,
             sum(a.quantity) as units, sum(a.savings_cents) as savings_cents
      from ${groups} g
      join ${allocations} a on a.group_id = g.id and a.state not in ('departed', 'released')
      join ${offers} o on o.id = g.offer_id
      where g.session_id = ${sessionId} and g.status in ('purchased', 'fulfilled')
      group by o.id, o.product_name, o.retailer
      order by savings_cents desc, o.id
    `);
    const money = await this.db.execute<{
      kind: string;
      status: string;
      operations: string;
      amount_cents: string;
    }>(sql`
      select kind, status, count(*) as operations, sum(amount_cents) as amount_cents
      from ${bankOperations} where session_id = ${sessionId}
      group by kind, status order by kind, status
    `);
    return {
      demand: demand.rows.map((row) => ({
        offerId: row.offer_id,
        productName: row.product_name,
        retailer: row.retailer,
        pickupWindow: row.pickup_window,
        packageQuantity: row.package_quantity,
        openNeeds: Number(row.open_needs),
        requestedUnits: Number(row.requested_units),
        fillablePackages: Math.floor(Number(row.requested_units) / row.package_quantity),
      })),
      outcomes: outcomes.rows.map((row) => ({
        status: row.status,
        origin: row.origin,
        groups: Number(row.groups),
        averageMembers: Number(row.avg_members ?? 0),
        savingsCents: Number(row.savings_cents),
      })),
      savings: savings.rows.map((row) => ({
        offerId: row.offer_id,
        productName: row.product_name,
        retailer: row.retailer,
        groups: Number(row.groups),
        shoppers: Number(row.shoppers),
        units: Number(row.units),
        savingsCents: Number(row.savings_cents),
      })),
      money: money.rows.map((row) => ({
        kind: row.kind,
        status: row.status,
        operations: Number(row.operations),
        amountCents: Number(row.amount_cents),
      })),
      queryIds: [],
    };
  }

  async summarizeInsights(evidence: InsightsEvidence) {
    return { text: templateInsights(evidence), requestId: null };
  }

  async parseNeed(input: { text: string; context: ParseContext }) {
    return { output: localParseNeed(input.text, input.context), requestId: null };
  }
}
