import { and, asc, eq, ne, sql } from "drizzle-orm";
import { type ExplanationEvidence, templateExplanation } from "@/domain/explanation";
import type { Db } from "@/server/db/client";
import { needs, offers } from "@/server/db/schema";
import type {
  AnalyticsProvider,
  CandidateQuery,
  OutboxRecord,
} from "@/server/providers/analytics/types";

/**
 * Rehearsal analytics: the same queries as Snowflake, answered from local Postgres data, with a
 * deterministic template explanation. Never used for a sponsor-mode session.
 */
export class LocalAnalyticsProvider implements AnalyticsProvider {
  readonly name = "local" as const;

  constructor(private readonly db: Db) {}

  async sync(records: OutboxRecord[]) {
    return { deliveredIds: records.map((record) => record.id) };
  }

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
}
