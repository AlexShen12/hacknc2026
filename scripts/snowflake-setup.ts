/** Create CommonCart analytical tables in the configured Snowflake database/schema. */
import { readFileSync } from "node:fs";
import { getSponsorConfig } from "@/server/config";
import { SnowflakeSqlClient } from "@/server/providers/analytics/snowflake";

if (process.env.RUN_LIVE_SPONSOR_CHECKS !== "true") {
  console.error("Refusing to call Snowflake: set RUN_LIVE_SPONSOR_CHECKS=true explicitly.");
  process.exit(1);
}
const { snowflake } = getSponsorConfig();
const client = new SnowflakeSqlClient(snowflake);
const statements = readFileSync("snowflake/schema.sql", "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const statement of statements) {
  const result = await client.execute(statement);
  console.log(`ok ${statement.split("(")[0]?.trim()} (statement ${result.statementHandle})`);
}
