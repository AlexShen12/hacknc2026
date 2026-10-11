import { currentSession, json, route } from "@/server/http";
import { createSnapshot, snapshotStatus } from "@/server/services/snapshot-service";

export async function GET(request: Request) {
  return route(request, async () => {
    await currentSession();
    return json(await snapshotStatus());
  });
}

/** Operator action: snapshot the demo database to a new Neon branch. */
export async function POST(request: Request) {
  return route(request, async () => {
    const session = await currentSession();
    return json(await createSnapshot(session), 201);
  });
}
