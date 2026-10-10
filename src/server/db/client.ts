import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/server/db/schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const cache = globalThis as { __commoncartDb?: { url: string; pool: Pool; db: Db } };

export function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (!cache.__commoncartDb || cache.__commoncartDb.url !== url) {
    const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
    cache.__commoncartDb = { url, pool, db: drizzle(pool, { schema }) };
  }
  return cache.__commoncartDb.db;
}

export async function closeDb(): Promise<void> {
  await cache.__commoncartDb?.pool.end();
  cache.__commoncartDb = undefined;
}
