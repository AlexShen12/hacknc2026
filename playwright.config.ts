import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile(".env");
} catch {
  // Environment may be provided directly (CI).
}
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for e2e tests");

const port = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", actionTimeout: 15_000 },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // Rehearsal providers against the dedicated test database; never live sponsors.
    command: `npm run build && npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: testDatabaseUrl,
      PROVIDER_MODE: "rehearsal",
      DEMO_CONTROLS_ENABLED: "true",
      APP_ORIGIN: `http://localhost:${port}`,
      NESSIE_API_KEY: "",
      SNOWFLAKE_PAT: "",
    },
  },
});
