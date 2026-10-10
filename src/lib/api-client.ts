/** Browser-side JSON client for the `{ data }` / `{ error }` envelopes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: {
      code: string;
      message: string;
      fields?: Record<string, string>;
      details?: Record<string, unknown>;
    };
  } | null;
  if (!response.ok || !payload || payload.error) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "NETWORK",
      error?.message ?? "Something went wrong. Please try again.",
      error?.fields,
      error?.details,
    );
  }
  return payload.data as T;
}

export const REFRESH_EVENT = "commoncart:refresh";

/** Ask open views (group detail, operator panel) to re-fetch after an action elsewhere. */
export function announceRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}
