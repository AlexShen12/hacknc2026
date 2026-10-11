import { z } from "zod";
import type { NeonConfig } from "@/server/config";
import { log } from "@/server/observability/logger";
import { PROVIDER_TIMEOUT_MS, ProviderError } from "@/server/providers/errors";

const NEON_API = "https://console.neon.tech/api/v2";

const branchSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().optional(),
  created_at: z.string(),
  default: z.boolean().optional(),
});
const endpointSchema = z.looseObject({ id: z.string(), host: z.string(), branch_id: z.string() });

export type NeonBranch = z.infer<typeof branchSchema>;

/**
 * Minimal Neon API client for database snapshots. Verified 2026-10-11 against the project the
 * key is scoped to: GET /projects/{id}, /endpoints and /branches.
 */
export class NeonClient {
  constructor(
    private readonly config: NeonConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${NEON_API}/projects/${this.config.projectId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS * 2),
      });
    } catch (error) {
      throw new ProviderError("neon", `Neon request failed: ${String(error)}`);
    }
    const json = (await response.json().catch(() => null)) as { message?: string } | null;
    log("info", "neon.request", { method, path, status: response.status });
    if (!response.ok) {
      throw new ProviderError(
        "neon",
        `Neon returned HTTP ${response.status}${json?.message ? `: ${json.message}` : ""}`,
        response.status,
      );
    }
    return json;
  }

  async listBranches(): Promise<NeonBranch[]> {
    const parsed = z.object({ branches: z.array(branchSchema) }).safeParse(await this.request("GET", "/branches"));
    if (!parsed.success) throw new ProviderError("neon", "Unexpected branches response");
    return parsed.data.branches;
  }

  /** The branch serving the application's database host (the pooled host shares its endpoint). */
  async branchForHost(host: string): Promise<string | null> {
    const parsed = z
      .object({ endpoints: z.array(endpointSchema) })
      .safeParse(await this.request("GET", "/endpoints"));
    if (!parsed.success) throw new ProviderError("neon", "Unexpected endpoints response");
    const endpointId = host.split(".")[0]?.replace(/-pooler$/, "");
    return parsed.data.endpoints.find((endpoint) => endpoint.id === endpointId)?.branch_id ?? null;
  }

  /** A branch without a compute endpoint: a copy-on-write snapshot that costs no compute. */
  async createBranch(name: string, parentId: string): Promise<NeonBranch> {
    const parsed = z
      .object({ branch: branchSchema })
      .safeParse(await this.request("POST", "/branches", { branch: { name, parent_id: parentId } }));
    if (!parsed.success) throw new ProviderError("neon", "Unexpected create-branch response");
    return parsed.data.branch;
  }

  async deleteBranch(branchId: string): Promise<void> {
    await this.request("DELETE", `/branches/${encodeURIComponent(branchId)}`);
  }
}
