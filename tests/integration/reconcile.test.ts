import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import { bankOperations } from "@/server/db/schema";
import { type Providers, providersFor, setProviderFactory } from "@/server/providers";
import { runDemoAction } from "@/server/services/demo-service";
import { contribute, reconcileOperation } from "@/server/services/funding-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { confirmTerms } from "@/server/services/workflow-service";
import { startScenario } from "./helpers";

afterEach(() => setProviderFactory(null));
afterAll(async () => {
  await closeDb();
});

describe("reconciliation without a verified correlation lookup", () => {
  it("keeps a lost-response contribution unknown and blocks readiness", async () => {
    const s = await startScenario();
    const base = providersFor("rehearsal");
    const nessieLike: Providers = {
      ...base,
      banking: Object.assign(Object.create(Object.getPrototypeOf(base.banking)), base.banking, {
        capabilities: { ...base.banking.capabilities, correlationLookup: false },
      }),
    };
    setProviderFactory(() => nessieLike);

    const alex = await s.ctx("alex");
    const need = await createNeed(alex.session, alex.shopperId, {
      offerId: await s.offerId(),
      quantity: 6,
      maxContributionCents: 2000,
      pickupWindow: s.pickupWindow,
    });
    const match = await runMatching(nessieLike, alex, need.id);
    const groupId = match.groups[0]?.id ?? "";
    for (const persona of ["alex", "jordan", "sam", "riley"] as const) {
      await confirmTerms(nessieLike, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await runDemoAction(nessieLike, await s.fresh(), { action: "set_fault", fault: "unknown" });
    const operation = await contribute(
      nessieLike,
      await s.ctx("alex"),
      groupId,
      await s.version(groupId),
    );
    expect(operation.status).toBe("unknown");

    const after = await reconcileOperation(nessieLike, await s.fresh(), operation.id);
    expect(after.status).toBe("unknown");
    const [row] = await getDb()
      .select()
      .from(bankOperations)
      .where(eq(bankOperations.id, operation.id));
    expect(row?.status).toBe("unknown");
    expect(row?.attemptCount).toBe(1);
    const view = await s.view(groupId);
    expect(view.status).toBe("funding");
    expect(view.blockers).toContain("bank_outcome_unknown");
    expect(view.viewer.actions).not.toContain("contribute");
  });
});
