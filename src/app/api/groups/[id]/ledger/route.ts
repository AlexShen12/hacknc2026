import { currentSession, json, route } from "@/server/http";
import { providersFor } from "@/server/providers";
import { requireReady } from "@/server/services/session-service";
import { groupLedger } from "@/server/services/wallet-service";

/** Read-only: re-reads the collection account's records from the bank. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(request, async () => {
    const session = await currentSession();
    requireReady(session);
    const { id } = await params;
    return json(
      await groupLedger(providersFor(session.mode), session, id, session.selectedShopperId),
    );
  });
}
