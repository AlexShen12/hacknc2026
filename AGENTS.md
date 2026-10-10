# CommonCart agent guide

## Read first
- Read [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the product and agreed MVP.
- Read [atlas.md](atlas.md) for boundaries and data flow, then [implementation.md](implementation.md) for the next milestone.
- Follow [conventions.md](conventions.md); use [techContext.md](techContext.md) for dependency pins, configuration and API references.
- Current state: documentation only. Application directories, commands and integrations described in these guides are planned until implemented and verified.

## Scope and boundaries
- Build the agreed 24-hour, hosted, needs-first demo with seeded personas and a friendly shopping-club UI.
- Use one TypeScript Next.js application, Neon Postgres for workflow state, Nessie for sandbox banking, and Snowflake for analytical queries and Cortex explanations.
- Keep money calculations and matching in pure domain functions. UI and route handlers call services; provider adapters own external contracts.
- Preserve `recover_icloud_trash_to_desktop.py`; it is unrelated to CommonCart.
- Retail fixtures are the default. Attempt the 45-minute scraping stretch only after the complete demo works.

## Essential invariants
- Represent money as integer USD cents. Convert provider amounts only in the banking adapter.
- Allocate the entire package and total cost exactly; enforce every participant's confirmed quantity and budget.
- Freeze terms at funding. Return a funded dropout's contribution before accepting replacement funding.
- Persist banking operations before dispatch. Never blindly retry an operation with an unknown external outcome.
- Use short Postgres transactions; keep external calls outside them. Database rollback cannot undo Nessie operations.
- Scope every read and mutation to the server-resolved demo session and authorized persona.
- Keep secrets server-side and redact Nessie query-string keys from logs.
- Keep `sponsor` and `rehearsal` modes explicit and fixed for each session. Never silently substitute mock success for a failed sponsor request.
- Cortex explains verified calculations; it does not invent prices, determine amounts or confirm transfers.

## Verification
- Once scaffolded: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:integration`, `npm run test:e2e`, `npm run build`.
- Use `npm run format:check` for formatting and `npm run format` only when intentionally rewriting files.
- Run the checks relevant to the change. Prioritize allocation, concurrency, reconciliation, isolation and the funded-dropout journey.
- `npm run verify:sponsors` requires explicit sandbox configuration; deterministic tests must not call live sponsors.
- For documentation-only changes, check links, consistency and examples; do not claim application tests have run.

## Maintaining the guides
- Update the owning document when a decision changes, then reconcile references in the others.
- Record observed API behavior separately from documented capabilities and unverified assumptions.
- Pin direct dependencies exactly and commit the lockfile during scaffolding; do not copy `latest` or prerelease install commands from vendor docs.
- Keep milestone status truthful. A planned endpoint, successful mock test or cached fixture is not a verified live integration.
