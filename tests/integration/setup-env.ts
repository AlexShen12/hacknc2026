try {
  process.loadEnvFile(".env");
} catch {
  // Environment may be provided directly (CI).
}
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.PROVIDER_MODE = "rehearsal";
process.env.DEMO_CONTROLS_ENABLED = "true";
