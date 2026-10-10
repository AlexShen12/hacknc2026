import { randomUUID } from "node:crypto";

/** Clock and ID generator, replaceable in deterministic tests. */
export const runtime = {
  now: (): Date => new Date(),
  newId: (prefix: string): string => `${prefix}_${randomUUID()}`,
};
