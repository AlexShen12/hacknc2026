# CommonCart

Get the savings of buying together without needing the whole package or fronting everyone else's money.

HackNC demo: a needs-first group-buying app built with Next.js, Postgres, Capital One Nessie (sandbox banking) and Snowflake (SQL and Cortex). Product scope is in [PROJECT_BRIEF.md](PROJECT_BRIEF.md); contributor rules are in [AGENTS.md](AGENTS.md).

## Run locally (rehearsal mode)

```sh
cp .env.example .env
docker compose up -d          # Postgres 18 on localhost:54329 (app and test databases)
npm ci
npm run db:migrate
npm run dev                   # http://localhost:3000
```

Rehearsal mode uses fictional retail fixtures, a Postgres-backed simulated bank ledger and local analytics. Sponsor mode needs the Nessie and Snowflake variables in `.env`; it fails explicitly if any are missing and never falls back to rehearsal.

## Demo script

1. Start the demo. Alex is selected with a prefilled need for 6 of 24 paper-towel rolls, up to $20.
2. **Find my group**: Alex, Jordan, Sam and Riley each pay $15.00 instead of $22.00. Taylor is excluded because their $12 limit is below the share.
3. Open the group and confirm as Alex. In **Demo controls**, confirm as Jordan, Sam and Riley.
4. Contribute as Alex, then as Jordan from Demo controls ($30 collected).
5. **Leave as Jordan**. Jordan's $15 is returned before anything else ($15 collected).
6. **Find a replacement**. Casey is offered the same 6 rolls for $15. Confirm and contribute as Casey, then contribute as Sam and Riley.
7. Record the purchase as Alex ($60), then mark all four pickups. The group saves $28.

Demo controls can also make the next bank operation stay pending, lose its response or be rejected, and can expire the offer, to show recovery paths.

## Checks

```sh
npm run lint && npm run format:check && npm run typecheck
npm run test               # domain and adapter unit tests
npm run test:integration   # Postgres-backed workflow tests (TEST_DATABASE_URL)
npm run test:e2e           # Playwright, desktop and mobile; first run: npx playwright install chromium
npm run build
npm run demo:seed          # validate fixtures and print the featured arithmetic
RUN_LIVE_SPONSOR_CHECKS=true npm run verify:sponsors   # live sandbox calls; explicit only
```

Current verification status is tracked in [implementation.md](implementation.md#implementation-status) and [techContext.md](techContext.md#integration-evidence-register).
