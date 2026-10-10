import type { Catalog } from "@/server/fixtures";

export interface RetailProvider {
  readonly name: "fixtures";
  /** Normalized offers with provenance. Scraped imports would use the same contract. */
  loadCatalog(): Catalog;
}
