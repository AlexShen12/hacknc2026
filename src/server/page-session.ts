import { sessionToken } from "@/server/http";
import { findSessionByToken, getSessionView } from "@/server/services/session-service";

/** Server Component helper: the current session row and view, or null when none exists. */
export async function getPageSession() {
  const session = await findSessionByToken(await sessionToken());
  if (!session) return null;
  return { session, view: await getSessionView(session) };
}
