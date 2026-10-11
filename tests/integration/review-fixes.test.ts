import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import { groups, offers } from "@/server/db/schema";
import { type Providers, providersFor, setProviderFactory } from "@/server/providers";
import { ProviderError } from "@/server/providers/errors";
import { runDemoAction } from "@/server/services/demo-service";
import { advanceGroup, contribute } from "@/server/services/funding-service";
import { createOpenGroup, joinGroup } from "@/server/services/group-builder-service";
import { runMatching } from "@/server/services/matching-service";
import { createNeed } from "@/server/services/need-service";
import { listNotifications } from "@/server/services/notification-service";
import { getGroupView } from "@/server/services/read-service";
import { getWallet } from "@/server/services/wallet-service";
import { confirmTerms, withdraw } from "@/server/services/workflow-service";
import { type Persona, type Scenario, startScenario } from "./helpers";

afterEach(() => setProviderFactory(null));
afterAll(async () => {
  await closeDb();
});

async function openGroup(
  s: Scenario,
  providers: Providers,
  options: { visibility?: "public" | "invite"; autoPurchase?: boolean } = {},
) {
  return createOpenGroup(providers, await s.ctx("alex"), {
    offerId: await s.offerId(),
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
    visibility: options.visibility ?? "public",
    autoPurchase: options.autoPurchase ?? false,
    autoPay: true,
  });
}

async function join(
  s: Scenario,
  providers: Providers,
  groupId: string,
  persona: Persona,
  options: { quantity?: number; autoPay?: boolean } = {},
) {
  return joinGroup(providers, await s.ctx(persona), groupId, await s.version(groupId), {
    quantity: options.quantity ?? 6,
    maxContributionCents: 2000,
    autoPay: options.autoPay ?? true,
  });
}

async function featuredProposal(s: Scenario) {
  const alex = await s.ctx("alex");
  const need = await createNeed(alex.session, alex.shopperId, {
    offerId: await s.offerId(),
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
  });
  return (await runMatching(s.providers, alex, need.id)).groups[0]?.id ?? "";
}

describe("leaving an open group before it fills", () => {
  it("frees the units without leaving a phantom vacancy", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, s.providers);
    await join(s, s.providers, groupId, "jordan", { quantity: 4 });
    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    let view = await s.view(groupId);
    expect(view.allocations.find((row) => row.name === "Jordan")?.state).toBe("released");
    expect(view).toMatchObject({ status: "open", remainingUnits: 18, vacancies: 0 });

    for (const persona of ["sam", "riley", "casey"] as Persona[]) {
      await join(s, s.providers, groupId, persona);
    }
    view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
    expect(view.vacancies).toBe(0);

    // A later funded dropout opens exactly that member's share, not Jordan's old 4 rolls.
    await withdraw(s.providers, await s.ctx("sam"), groupId, await s.version(groupId));
    view = await s.view(groupId, "taylor");
    expect(view.vacancies).toBe(1);
    expect(view.joinSlot).toEqual({ mode: "slot", quantity: 6, contributionCents: 1500 });
  });
});

describe("auto-replacement", () => {
  it("offers the slot when the person who leaves never paid", async () => {
    const s = await startScenario();
    const groupId = await featuredProposal(s);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      await confirmTerms(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    const view = await s.view(groupId);
    expect(view.status).toBe("replacement_needed");
    expect(view.allocations.find((row) => row.name === "Casey")).toMatchObject({
      isReplacement: true,
      consented: false,
    });
  });
});

describe("offer changes during confirmation", () => {
  it("releases every reservation when the proposal is cancelled", async () => {
    const s = await startScenario();
    const groupId = await featuredProposal(s);
    await confirmTerms(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
    expect((await s.needOf("riley"))?.status).toBe("reserved");
    const [group] = await getDb().select().from(groups).where(eq(groups.id, groupId));
    await getDb()
      .update(offers)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(offers.id, group?.offerId ?? ""), eq(offers.sessionId, s.session.id)));

    await expect(
      confirmTerms(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId)),
    ).rejects.toMatchObject({ code: "OFFER_CHANGED" });
    expect((await s.view(groupId)).status).toBe("cancelled");
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      expect((await s.needOf(persona))?.status).toBe("forming");
    }
  });
});

describe("open groups suggested by matching", () => {
  it("uses the domain join rules, including estimated prices", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, s.providers);
    const casey = await s.ctx("casey");
    const need = await createNeed(casey.session, casey.shopperId, {
      offerId: await s.offerId(),
      quantity: 7,
      maxContributionCents: 2000,
      pickupWindow: s.pickupWindow,
    });
    const match = await runMatching(s.providers, casey, need.id);
    expect(match.openGroups.map((group) => group.id)).toContain(groupId);
  });
});

describe("spendable money", () => {
  it("holds contributions still waiting on the bank", async () => {
    const s = await startScenario();
    const groupId = await featuredProposal(s);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      await confirmTerms(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await runDemoAction(s.providers, await s.fresh(), { action: "set_fault", fault: "pending" });
    const operation = await contribute(
      s.providers,
      await s.ctx("alex"),
      groupId,
      await s.version(groupId),
    );
    expect(operation.status).toBe("pending");
    const wallet = await getWallet(s.providers, await s.fresh(), s.ids.alex);
    expect(wallet.pendingOutCents).toBe(1500);
    expect(wallet.spendableCents).toBe(10000 - 5500 - 2000 - 1500);
  });
});

describe("invite-only groups", () => {
  it("shows the invite code to members only", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, s.providers, { visibility: "invite" });
    const asMember = await getGroupView(s.providers, await s.fresh(), groupId, s.ids.alex);
    const asStranger = await getGroupView(s.providers, await s.fresh(), groupId, s.ids.sam);
    expect(asMember.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(asStranger.inviteCode).toBeNull();
  });
});

describe("auto-pay", () => {
  it("survives a transient bank error and pays on the next update", async () => {
    const s = await startScenario();
    const base = providersFor("rehearsal");
    let calls = 0;
    let failFrom = Number.POSITIVE_INFINITY;
    const flaky: Providers = {
      ...base,
      banking: Object.assign(Object.create(Object.getPrototypeOf(base.banking)), base.banking, {
        listBills: async (accountRef: string) => {
          calls += 1;
          if (calls >= failFrom) throw new ProviderError("nessie", "temporarily unavailable", 503);
          return base.banking.listBills(accountRef);
        },
      }),
    };
    const groupId = await openGroup(s, flaky, { autoPurchase: true });
    await join(s, flaky, groupId, "jordan");
    await join(s, flaky, groupId, "sam");
    failFrom = calls + 2; // the filling join's own check passes; auto-pay checks then fail
    await join(s, flaky, groupId, "riley");

    let view = await s.view(groupId);
    expect(view.status).toBe("funding");
    expect(view.allocations.every((row) => row.autoPay)).toBe(true);
    const feed = await listNotifications(s.session.id, s.ids.sam);
    expect(feed.items.some((item) => item.kind === "auto_pay_paused")).toBe(false);

    failFrom = Number.POSITIVE_INFINITY;
    await advanceGroup(flaky, await s.fresh(), groupId);
    view = await s.view(groupId);
    expect(view.status).toBe("purchased");
  });

  it("tells members without auto-pay to contribute when the group fills", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, s.providers);
    await join(s, s.providers, groupId, "jordan", { autoPay: false });
    await join(s, s.providers, groupId, "sam");
    await join(s, s.providers, groupId, "riley");
    const jordan = await listNotifications(s.session.id, s.ids.jordan);
    const sam = await listNotifications(s.session.id, s.ids.sam);
    expect(jordan.items.map((item) => item.message)).toContain(
      "Your Everyday Paper Towels group is full! Contribute your $15.00 share to keep things moving.",
    );
    expect(sam.items.map((item) => item.message)).toContain(
      "Your Everyday Paper Towels group is full! Your $15.00 share is being sent automatically.",
    );
  });
});

describe("second review round", () => {
  it("keeps a lost response unknown when a lookup miss is not proof (Nessie)", async () => {
    const s = await startScenario();
    const base = providersFor("rehearsal");
    const nessieLike: Providers = {
      ...base,
      banking: Object.assign(Object.create(Object.getPrototypeOf(base.banking)), base.banking, {
        capabilities: { ...base.banking.capabilities, correlationAbsenceIsProof: false },
        findByCorrelation: async () => ({ found: false }) as const,
      }),
    };
    setProviderFactory(() => nessieLike);
    const groupId = await featuredProposal(s);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
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
    const { reconcileOperation } = await import("@/server/services/funding-service");
    const after = await reconcileOperation(nessieLike, await s.fresh(), operation.id);
    expect(after.status).toBe("unknown");
    // Nothing is offered for retry while the outcome is unknown.
    expect((await s.view(groupId)).viewer.actions).not.toContain("contribute");
  });

  it("tells members who already paid that nothing more is needed", async () => {
    const s = await startScenario();
    const groupId = await featuredProposal(s);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      await confirmTerms(s.providers, await s.ctx(persona), groupId, await s.version(groupId));
    }
    await contribute(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    await confirmTerms(s.providers, await s.ctx("casey"), groupId, await s.version(groupId));
    const alex = await listNotifications(s.session.id, s.ids.alex);
    expect(alex.items[0]?.message).toBe(
      "The open share in the Everyday Paper Towels group is filled. Your $15.00 share is already in; nothing to do.",
    );
  });

  it("keeps consent when rounding lowers a share, so auto-pay still runs", async () => {
    const s = await startScenario();
    await getDb()
      .update(offers)
      .set({ itemCents: 6001, totalCents: 6001 })
      .where(and(eq(offers.id, await s.offerId()), eq(offers.sessionId, s.session.id)));
    const groupId = await openGroup(s, s.providers);
    for (const persona of ["jordan", "sam", "riley"] as Persona[]) {
      await join(s, s.providers, groupId, persona);
    }
    const view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
    const shares = view.allocations.map((row) => row.contributionCents).sort();
    expect(shares).toEqual([1500, 1500, 1500, 1501]);
    expect(view.retainedCents).toBe(6001);
    expect(view.allocations.every((row) => row.consented)).toBe(true);
  });

  it("counts bills with an unknown due date against spendable money", async () => {
    const s = await startScenario();
    const [shopper] = await getDb()
      .select()
      .from((await import("@/server/db/schema")).shoppers)
      .where(eq((await import("@/server/db/schema")).shoppers.id, s.ids.sam));
    await s.providers.banking.provisionBill({
      sessionId: s.session.id,
      accountRef: shopper?.fundingAccountRef ?? "",
      payee: "Undated bill",
      amountCents: 1000,
      dueDate: "",
    });
    const wallet = await getWallet(s.providers, await s.fresh(), s.ids.sam);
    expect(wallet.billsDueCents).toBe(3500 + 1000);
  });

  it("shows a group's money movements to members only", async () => {
    const s = await startScenario();
    const groupId = await featuredProposal(s);
    const { groupLedger } = await import("@/server/services/wallet-service");
    await expect(
      groupLedger(s.providers, await s.fresh(), groupId, s.ids.taylor),
    ).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    await expect(
      groupLedger(s.providers, await s.fresh(), groupId, s.ids.alex),
    ).resolves.toMatchObject({
      account: null,
    });
  });
});
