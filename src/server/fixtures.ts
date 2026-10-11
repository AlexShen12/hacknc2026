import { z } from "zod";
import catalogJson from "../../fixtures/catalog.json";
import personasJson from "../../fixtures/personas.json";

const cents = z.number().int().nonnegative();
const membership = z.enum(["costco", "sams_club"]);

const offerSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/),
    retailer: z.enum(["walmart", "costco", "sams_club"]),
    storeName: z.string(),
    sku: z.string(),
    productFamily: z.string(),
    productName: z.string(),
    unit: z.string(),
    packageQuantity: z.number().int().positive(),
    itemCents: cents,
    taxCents: cents,
    feeCents: cents,
    baselines: z.array(z.object({ quantity: z.number().int().positive(), baselineCents: cents })),
    membershipRequired: membership.nullable(),
    pickupWindows: z.array(z.string()).min(1),
    available: z.boolean(),
    expiresInHours: z.number().positive(),
    image: z.string().startsWith("/"),
  })
  .refine((offer) => offer.baselines.every((item) => item.quantity < offer.packageQuantity), {
    message: "Baselines must cover partial quantities",
  });

const storeSchema = z.object({
  name: z.string().min(1),
  address: z.object({
    streetNumber: z.string(),
    streetName: z.string(),
    city: z.string(),
    state: z.string().length(2),
    zip: z.string(),
  }),
  geocode: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
});

const catalogSchema = z.object({
  fixtureVersion: z.string(),
  notice: z.string(),
  pickupZone: z.object({ key: z.string(), label: z.string() }),
  pickupWindows: z.array(
    z.object({
      key: z.string(),
      startOffsetHours: z.number().int().nonnegative(),
      durationHours: z.number().int().positive(),
    }),
  ),
  /** Each retailer's (fictional) store: created as a Nessie merchant with its map location. */
  stores: z.object({
    walmart: storeSchema,
    costco: storeSchema,
    sams_club: storeSchema,
  }),
  offers: z.array(offerSchema).min(1),
});

const needSeed = z.object({
  offerKey: z.string(),
  quantity: z.number().int().positive(),
  maxContributionCents: cents,
  pickupWindow: z.string(),
});

const personasSchema = z.object({
  scenarioVersion: z.string(),
  notice: z.string(),
  defaultPersona: z.string(),
  personas: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z]+$/),
        displayName: z.string(),
        tagline: z.string(),
        openingBalanceCents: cents,
        bufferCents: cents,
        memberships: z.array(membership),
        draftNeed: needSeed.nullable(),
        seededNeed: needSeed
          .extend({ minutesBeforeSession: z.number().int().positive() })
          .nullable(),
        bills: z
          .array(
            z.object({
              payee: z.string().min(1),
              amountCents: cents,
              dueInDays: z.number().int().nonnegative(),
            }),
          )
          .default([]),
      }),
    )
    .min(2),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogOffer = Catalog["offers"][number];
export type PersonaScenario = z.infer<typeof personasSchema>;

let cachedCatalog: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cachedCatalog) return cachedCatalog;
  const catalog = catalogSchema.parse(catalogJson);
  const windows = new Set(catalog.pickupWindows.map((window) => window.key));
  for (const offer of catalog.offers) {
    for (const window of offer.pickupWindows) {
      if (!windows.has(window)) throw new Error(`Unknown pickup window ${window} in ${offer.key}`);
    }
  }
  cachedCatalog = catalog;
  return catalog;
}

export function loadPersonas(catalog = loadCatalog()): PersonaScenario {
  const scenario = personasSchema.parse(personasJson);
  const offerKeys = new Set(catalog.offers.map((offer) => offer.key));
  for (const persona of scenario.personas) {
    for (const need of [persona.draftNeed, persona.seededNeed]) {
      if (need && !offerKeys.has(need.offerKey)) {
        throw new Error(`Persona ${persona.key} references unknown offer ${need.offerKey}`);
      }
    }
  }
  if (!scenario.personas.some((persona) => persona.key === scenario.defaultPersona)) {
    throw new Error("Default persona missing");
  }
  return scenario;
}
