import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import { groups, shoppers } from "@/server/db/schema";
import {
  createOpenGroup,
  joinGroup,
  updateGroupSettings,
} from "@/server/services/group-builder-service";
import { runMatching } from "@/server/services/matching-service";
import { listNotifications } from "@/server/services/notification-service";
import { confirmTerms, withdraw } from "@/server/services/workflow-service";
import { type Persona, type Scenario, startScenario } from "./helpers";

afterAll(async () => {
  await closeDb();
});

async function openGroup(
  s: Scenario,
  options: { visibility?: "public" | "invite"; autoPurchase?: boolean } = {},
) {
  return createOpenGroup(s.providers, await s.ctx("alex"), {
    offerId: await s.offerId(),
    quantity: 6,
    maxContributionCents: 2000,
    pickupWindow: s.pickupWindow,
    visibility: options.visibility ?? "public",
    autoPurchase: options.autoPurchase ?? true,
    autoPay: true,
  });
}

async function join(
  s: Scenario,
  groupId: string,
  persona: Persona,
  extra: Partial<Parameters<typeof joinGroup>[4]> = {},
) {
  return joinGroup(s.providers, await s.ctx(persona), groupId, await s.version(groupId), {
    quantity: 6,
    maxContributionCents: 2000,
    autoPay: true,
    ...extra,
  });
}

describe("organizer-created groups", () => {
  it("fills by joining, auto-pays once full and auto-purchases when funded", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s);
    let view = await s.view(groupId);
    expect(view).toMatchObject({ status: "open", remainingUnits: 18, origin: "organizer" });
    expect(view.inviteCode).toMatch(/^[A-Z2-9]{8}$/);

    await join(s, groupId, "jordan");
    await join(s, groupId, "sam");
    expect((await s.view(groupId)).remainingUnits).toBe(6);
    // Nothing is charged before the group is full.
    expect(await s.balance("alex")).toBe(10000);

    await join(s, groupId, "riley");
    view = await s.view(groupId);
    expect(view.status).toBe("purchased");
    expect(view.operations.map((row) => [row.kind, row.status])).toEqual([
      ["contribution", "confirmed"],
      ["contribution", "confirmed"],
      ["contribution", "confirmed"],
      ["contribution", "confirmed"],
      ["purchase", "confirmed"],
    ]);
    for (const persona of ["alex", "jordan", "sam", "riley"] as Persona[]) {
      expect(await s.balance(persona)).toBe(8500);
    }
    expect((await s.needOf("jordan"))?.status).toBe("reserved");

    const feed = await listNotifications(s.session.id, s.ids.jordan);
    const messages = feed.items.map((item) => item.message).join("\n");
    expect(messages).toContain("You joined the Everyday Paper Towels group");
    expect(messages).toContain("Your $15.00 contribution is confirmed.");
    expect(messages).toContain("purchase is recorded");
    expect(feed.unread).toBeGreaterThan(0);
  });

  it("requires the invite code for invite-only groups", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, { visibility: "invite" });
    await expect(join(s, groupId, "sam")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    const [group] = await getDb().select().from(groups).where(eq(groups.id, groupId));
    await join(s, groupId, "sam", { inviteCode: group?.inviteCode });
    expect((await s.view(groupId)).remainingUnits).toBe(12);
  });

  it("validates joins against remaining units and budgets", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s);
    await expect(join(s, groupId, "jordan", { quantity: 24 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(join(s, groupId, "taylor", { maxContributionCents: 1200 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { maxContribution: expect.any(String) } },
    });
    await expect(join(s, groupId, "alex")).rejects.toMatchObject({ code: "NEED_UNAVAILABLE" });
  });

  it("hands an open group to the next member when the organizer leaves", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s);
    await join(s, groupId, "jordan");
    await withdraw(s.providers, await s.ctx("alex"), groupId, await s.version(groupId));
    const view = await s.view(groupId, "jordan");
    expect(view).toMatchObject({ status: "open", organizerName: "Jordan", remainingUnits: 18 });
    expect((await s.needOf("alex"))?.status).toBe("withdrawn");
  });

  it("returns a funded dropout's money and auto-offers the exact share", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, { autoPurchase: false });
    for (const persona of ["jordan", "sam", "riley"] as Persona[]) await join(s, groupId, persona);
    expect((await s.view(groupId)).status).toBe("ready_to_purchase");

    await withdraw(s.providers, await s.ctx("jordan"), groupId, await s.version(groupId));
    let view = await s.view(groupId);
    expect(await s.balance("jordan")).toBe(10000);
    const casey = view.allocations.find((row) => row.name === "Casey");
    expect(casey).toMatchObject({ consented: false, contributionCents: 1500, isReplacement: true });
    const offered = await listNotifications(s.session.id, s.ids.casey);
    expect(offered.items[0]?.message).toContain("You've been offered");

    await confirmTerms(s.providers, await s.ctx("casey"), groupId, await s.version(groupId), {
      autoPay: true,
    });
    view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
    expect(view.retainedCents).toBe(6000);
  });

  it("lets anyone take a vacated share when auto-replacement is off", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, { autoPurchase: false });
    await updateGroupSettings(s.providers, await s.ctx("alex"), groupId, await s.version(groupId), {
      autoReplace: false,
    });
    for (const persona of ["jordan", "sam", "riley"] as Persona[]) await join(s, groupId, persona);
    await withdraw(s.providers, await s.ctx("sam"), groupId, await s.version(groupId));
    let view = await s.view(groupId, "casey");
    expect(view.status).toBe("replacement_needed");
    expect(view.joinSlot).toEqual({ mode: "slot", quantity: 6, contributionCents: 1500 });
    expect(view.viewer.actions).toEqual(["join"]);

    await expect(join(s, groupId, "casey", { quantity: 4 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await join(s, groupId, "casey");
    view = await s.view(groupId);
    expect(view.status).toBe("ready_to_purchase");
  });

  it("pauses auto-pay instead of dipping into the bill buffer", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s, { autoPurchase: true });
    await join(s, groupId, "jordan");
    await join(s, groupId, "sam");
    await getDb().update(shoppers).set({ bufferCents: 9000 }).where(eq(shoppers.id, s.ids.sam));
    await join(s, groupId, "riley");
    const view = await s.view(groupId);
    expect(view.status).toBe("funding");
    const sam = view.allocations.find((row) => row.name === "Sam");
    expect(sam).toMatchObject({ autoPay: false, contributionStatus: null });
    expect(await s.balance("sam")).toBe(10000);
    const feed = await listNotifications(s.session.id, s.ids.sam);
    expect(feed.items[0]?.message).toContain("Auto-pay paused");
  });

  it("suggests listed open groups from needs-first matching", async () => {
    const s = await startScenario();
    const groupId = await openGroup(s);
    const caseyNeed = await s.needOf("casey");
    const match = await runMatching(s.providers, await s.ctx("casey"), caseyNeed?.id ?? "");
    expect(match.openGroups.map((group) => group.id)).toContain(groupId);
  });
});
