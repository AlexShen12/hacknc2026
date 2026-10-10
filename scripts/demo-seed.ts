/**
 * Validate the versioned demo catalog and scenario. Sessions copy these fixtures into Postgres
 * when they are created, so this command checks the inputs and prints the featured arithmetic.
 */
import { findProposals } from "@/domain/matching";
import { formatCents } from "@/domain/money";
import { loadCatalog, loadPersonas } from "@/server/fixtures";

const catalog = loadCatalog();
const scenario = loadPersonas(catalog);
console.log(`Catalog ${catalog.fixtureVersion}: ${catalog.offers.length} offers`);
console.log(`Scenario ${scenario.scenarioVersion}: ${scenario.personas.length} personas`);

const now = new Date();
const featuredKey = scenario.personas.find((p) => p.draftNeed)?.draftNeed?.offerKey;
const featured = catalog.offers.find((offer) => offer.key === featuredKey);
if (!featured) throw new Error("Featured offer missing");
const offer = {
  id: featured.key,
  retailer: featured.retailer,
  sku: featured.sku,
  productFamily: featured.productFamily,
  unit: featured.unit,
  packageQuantity: featured.packageQuantity,
  itemCents: featured.itemCents,
  taxCents: featured.taxCents,
  feeCents: featured.feeCents,
  totalCents: featured.itemCents + featured.taxCents + featured.feeCents,
  baselines: featured.baselines,
  membershipRequired: featured.membershipRequired,
  pickupZone: catalog.pickupZone.key,
  pickupWindows: featured.pickupWindows,
  available: true,
  expiresAt: new Date(now.getTime() + 3_600_000),
  version: 1,
};
const needs = scenario.personas.map((persona) => {
  const seed = persona.draftNeed ?? persona.seededNeed;
  if (!seed) throw new Error(`Persona ${persona.key} has no need`);
  const minutes = persona.seededNeed?.minutesBeforeSession ?? 0;
  return {
    id: persona.key,
    shopperId: persona.key,
    acceptedOfferIds: [seed.offerKey],
    quantity: seed.quantity,
    maxContributionCents: seed.maxContributionCents,
    pickupZone: catalog.pickupZone.key,
    pickupWindow: seed.pickupWindow,
    createdAt: new Date(now.getTime() - minutes * 60_000),
  };
});
const [initiator, ...others] = needs;
if (!initiator) throw new Error("No initiator");
const result = findProposals({
  initiatingNeed: initiator,
  candidateNeeds: others,
  offers: [offer],
  shoppers: new Map(
    scenario.personas.map((p) => [
      p.key,
      {
        id: p.key,
        displayName: p.displayName,
        memberships: p.memberships,
        availableCents: p.openingBalanceCents - p.bufferCents,
      },
    ]),
  ),
  now,
});
const best = result.proposals[0];
if (!best) throw new Error("Featured scenario produces no group");
for (const allocation of best.allocations) {
  console.log(
    `  ${allocation.shopperId}: ${allocation.quantity} ${featured.unit} for ${formatCents(allocation.contributionCents)} (saves ${formatCents(allocation.savingsCents)})`,
  );
}
console.log(`  group saves ${formatCents(best.totalSavingsCents)}`);
for (const item of result.exclusions) console.log(`  excluded ${item.shopperId}: ${item.reason}`);
