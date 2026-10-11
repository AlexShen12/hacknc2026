import { currentSession, json, route } from "@/server/http";
import { listJoinableGroups } from "@/server/services/group-builder-service";

/** Listed organizer-created groups the selected shopper can join. */
export async function GET(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    const offerId = new URL(request.url).searchParams.get("offerId");
    return json(
      await listJoinableGroups(session, session.selectedShopperId, {
        offerIds: offerId ? [offerId] : undefined,
      }),
    );
  });
}
