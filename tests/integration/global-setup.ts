import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Apply reviewed migrations to the dedicated test database; refuse the application database. */
export default async function setup() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Environment may be provided directly (CI).
  }
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL is required for integration tests");
  if (testUrl === process.env.DATABASE_URL || testUrl === process.env.DATABASE_DIRECT_URL) {
    throw new Error("TEST_DATABASE_URL must not point at the application database");
  }
  const pool = new Pool({ connectionString: testUrl });
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await pool.end();
}
