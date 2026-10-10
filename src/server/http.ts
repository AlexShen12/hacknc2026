import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError, type ErrorCode } from "@/domain/errors";
import { getConfig } from "@/server/config";
import { log } from "@/server/observability/logger";
import { providersFor } from "@/server/providers";
import type { ActionContext } from "@/server/services/funding-service";
import {
  requireReady,
  requireSelectedShopper,
  requireSession,
  SESSION_COOKIE,
  type SessionRow,
} from "@/server/services/session-service";

const STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_AMOUNT: 400,
  INVALID_ALLOCATION: 400,
  SESSION_REQUIRED: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_AUTHORIZED: 403,
  DEMO_CONTROLS_DISABLED: 403,
  NOT_FOUND: 404,
  STALE_PROPOSAL: 409,
  INCOMPATIBLE_STATE: 409,
  NEED_UNAVAILABLE: 409,
  OFFER_CHANGED: 409,
  INSUFFICIENT_FUNDS: 409,
  NO_FEASIBLE_GROUP: 409,
  NO_REPLACEMENT: 409,
  RETURN_PENDING: 409,
  BANK_OUTCOME_UNKNOWN: 409,
  ALLOCATION_INVARIANT: 409,
  UPSTREAM_UNAVAILABLE: 503,
  SPONSOR_NOT_CONFIGURED: 503,
};

export function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(requestId: string, error: DomainError): Response {
  const fields = error.details?.fields as Record<string, string> | undefined;
  const { fields: _omit, ...details } = error.details ?? {};
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(fields ? { fields } : {}),
        ...(Object.keys(details).length ? { details } : {}),
      },
    },
    { status: STATUS[error.code], headers: { "cache-control": "no-store" } },
  );
}

/** Mutations must come from this application's own origin. */
function checkOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  const allowed = new Set([new URL(request.url).origin]);
  const configured = getConfig().APP_ORIGIN;
  if (configured) allowed.add(configured.replace(/\/$/, ""));
  if (!origin || !allowed.has(origin)) {
    throw new DomainError("FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
}

/** Wrap a route handler with origin checks, error envelopes and request logging. */
export async function route(
  request: Request,
  handler: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  const started = Date.now();
  try {
    checkOrigin(request);
    const response = await handler(requestId);
    log("info", "http.request", {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  } catch (error) {
    if (error instanceof DomainError) {
      log(error.code === "UPSTREAM_UNAVAILABLE" ? "warn" : "info", "http.domain_error", {
        requestId,
        path: new URL(request.url).pathname,
        code: error.code,
      });
      return errorResponse(requestId, error);
    }
    log("error", "http.unhandled", {
      requestId,
      path: new URL(request.url).pathname,
      error: String(error),
    });
    return Response.json(
      { error: { code: "INTERNAL", message: "Something went wrong.", requestId } },
      { status: 500 },
    );
  }
}

export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DomainError("INVALID_INPUT", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "body"] = issue.message;
    throw new DomainError("INVALID_INPUT", "Some fields are invalid.", { fields });
  }
  return parsed.data;
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function currentSession(): Promise<SessionRow> {
  return requireSession(await sessionToken());
}

export async function setSessionCookie(request: Request, token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

/** Resolve the session, its fixed-mode providers and the selected persona for a consumer action. */
export async function personaContext() {
  const session = await currentSession();
  requireReady(session);
  const shopperId = requireSelectedShopper(session);
  const providers = providersFor(session.mode);
  const ctx: ActionContext = { session, shopperId, actor: shopperId };
  return { session, providers, ctx };
}

export const versionBody = z.object({ expectedVersion: z.number().int().positive() });
