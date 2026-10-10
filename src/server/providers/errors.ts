import { DomainError } from "@/domain/errors";

/** A retryable upstream read/sync failure. Never converted into rehearsal data. */
export class ProviderError extends DomainError {
  constructor(
    readonly provider: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super("UPSTREAM_UNAVAILABLE", message, { provider, httpStatus });
    this.name = "ProviderError";
  }
}

export const PROVIDER_TIMEOUT_MS = 10_000;

export async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error instanceof ProviderError ? error.httpStatus : undefined;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw lastError;
}
