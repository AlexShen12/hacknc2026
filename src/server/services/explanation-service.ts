import { eq } from "drizzle-orm";
import { type ExplanationEvidence, validateExplanation } from "@/domain/explanation";
import { RETAILER_LABELS } from "@/lib/format";
import { getDb } from "@/server/db/client";
import { groups, type StoredExplanation } from "@/server/db/schema";
import { log } from "@/server/observability/logger";
import type { Providers } from "@/server/providers";
import { runtime } from "@/server/runtime";
import { buildGroupView, currentMembers, loadGroupBundle } from "@/server/services/group-view";
import type { SessionRow } from "@/server/services/session-service";

/**
 * Ask the analytics provider to explain the current proposal snapshot. Numbers shown in the UI
 * always come from domain output; the explanation is validated against the same evidence.
 */
export async function explainGroup(
  providers: Providers,
  session: SessionRow,
  groupId: string,
  viewerShopperId: string | null,
) {
  const db = getDb();
  const bundle = await loadGroupBundle(db, session.id, groupId);
  const view = buildGroupView(session, bundle, viewerShopperId, null);
  const members = currentMembers(bundle.allocations);
  const evidence: ExplanationEvidence = {
    groupId,
    proposalVersion: bundle.group.version,
    productName: bundle.offer.productName,
    retailerLabel: RETAILER_LABELS[bundle.offer.retailer],
    unit: bundle.offer.unit,
    packageQuantity: bundle.offer.packageQuantity,
    totalCents: bundle.group.totalCents,
    taxCents: bundle.offer.taxCents,
    feeCents: bundle.offer.feeCents,
    pickupLabel: view.pickupLabel,
    sourceLabel: view.offer.sourceLabel,
    members: members.map((member) => ({
      name: bundle.shoppers.get(member.shopperId)?.displayName ?? "Shopper",
      quantity: member.quantity,
      contributionCents: member.contributionCents,
      baselineCents: member.baselineCents,
      savingsCents: member.savingsCents,
    })),
    totalSavingsCents: members.reduce((sum, member) => sum + member.savingsCents, 0),
    excluded: view.exclusions,
  };

  let stored: StoredExplanation;
  try {
    const response = await providers.analytics.explain(evidence);
    const check = validateExplanation(response.text, evidence);
    stored = check.ok
      ? {
          proposalVersion: evidence.proposalVersion,
          source: providers.analytics.name === "snowflake" ? "cortex" : "template",
          text: check.text,
          status: "ready",
          requestId: response.requestId,
          generatedAt: runtime.now().toISOString(),
        }
      : {
          proposalVersion: evidence.proposalVersion,
          source: providers.analytics.name === "snowflake" ? "cortex" : "template",
          text: null,
          status: "unavailable",
          reason: `rejected_${check.reason}`,
          requestId: response.requestId,
          generatedAt: runtime.now().toISOString(),
        };
  } catch (error) {
    log("warn", "explanation.failed", { sessionId: session.id, groupId, error: String(error) });
    stored = {
      proposalVersion: evidence.proposalVersion,
      source: providers.analytics.name === "snowflake" ? "cortex" : "template",
      text: null,
      status: "unavailable",
      reason: "provider_error",
      generatedAt: runtime.now().toISOString(),
    };
  }
  await db.update(groups).set({ explanation: stored }).where(eq(groups.id, groupId));
  return {
    status: stored.status,
    source: stored.source,
    text: stored.text,
    proposalVersion: stored.proposalVersion,
    stale: false,
    reason: stored.reason,
  };
}
