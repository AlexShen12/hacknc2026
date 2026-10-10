import { loadCatalog } from "@/server/fixtures";
import type { RetailProvider } from "@/server/providers/retail/types";

export class FixtureRetailProvider implements RetailProvider {
  readonly name = "fixtures" as const;

  loadCatalog() {
    return loadCatalog();
  }
}
