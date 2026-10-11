# CommonCart technical context

Status: **dependencies installed and building; sponsor integrations unverified**. Versions below were checked against official npm/Node release metadata during planning on **October 10, 2026** and installed exactly (see the evidence register). No authenticated sponsor call or deployment has been performed.

See [implementation.md](implementation.md) for acceptance gates and [conventions.md](conventions.md) for dependency and provider rules.

## Runtime and deployment

| Component | Selected version/configuration | Reference |
| --- | --- | --- |
| Local Node.js | `24.21.0` | [Node 24 API](https://nodejs.org/docs/latest-v24.x/api/), [official release metadata](https://nodejs.org/dist/index.json) |
| npm | `11.19.0` | [npm documentation](https://docs.npmjs.com/) |
| Vercel runtime | Node `24.x`; provider-managed patches | [Supported Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) |
| Operational database | Neon Postgres **18**; provider-managed patch version | [Neon project/version API](https://api-docs.neon.tech/reference/createproject), [Postgres 18](https://www.postgresql.org/docs/18/) |
| UI/server framework | Next.js App Router, Node runtime for database/provider routes | [Installation](https://nextjs.org/docs/app/getting-started/installation), [Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route) |

Use `.nvmrc` for local Node `24.21.0`, `packageManager: "npm@11.19.0"`, and `engines.node: "24.x"` during scaffolding. The machine observed during planning had Node `26.7.0`; switch the project to its selected Node 24 version before compatibility checks. Do not claim an exact Vercel or Neon patch pin: record the observed deployed versions at verification time.

## Exact package pins

Use the literal package names and versions below in the future manifest, without `^`, `~`, `latest` or prerelease tags. Registry evidence for each package is available at `https://registry.npmjs.org/<package>/<version>`; encode scoped package names when required by the client.

### Application dependencies

| Package | Version | Official documentation |
| --- | --- | --- |
| `next` | `16.4.0` | [Next.js App Router](https://nextjs.org/docs/app) |
| `react` | `19.3.0` | [React API](https://react.dev/reference/react) |
| `react-dom` | `19.3.0` | [React DOM](https://react.dev/reference/react-dom) |
| `radix-ui` | `1.7.0` | [Radix primitives](https://www.radix-ui.com/primitives/docs/overview/introduction) |
| `lucide-react` | `1.55.0` | [Lucide React](https://lucide.dev/guide/react) |
| `clsx` | `2.1.1` | [clsx repository](https://github.com/lukeed/clsx) |
| `tailwind-merge` | `3.7.0` | [tailwind-merge repository](https://github.com/dcastil/tailwind-merge) |
| `zod` | `4.6.5` | [Zod](https://zod.dev/) |
| `drizzle-orm` | `0.45.4` | [Postgres connection](https://orm.drizzle.team/docs/get-started-postgresql), [transactions](https://orm.drizzle.team/docs/transactions) |
| `pg` | `8.23.1` | [node-postgres](https://node-postgres.com/), [transaction requirements](https://node-postgres.com/features/transactions) |

### Development dependencies

| Package | Version | Official documentation |
| --- | --- | --- |
| `typescript` | `7.0.2` | [TypeScript](https://www.typescriptlang.org/docs/) |
| `tailwindcss` | `4.3.3` | [Tailwind with Next.js](https://tailwindcss.com/docs/installation/framework-guides/nextjs) |
| `@tailwindcss/postcss` | `4.3.3` | [Tailwind PostCSS setup](https://tailwindcss.com/docs/installation/using-postcss) |
| `postcss` | `8.5.29` | [PostCSS](https://postcss.org/) |
| `drizzle-kit` | `0.31.11` | [Drizzle migrations](https://orm.drizzle.team/docs/migrations) |
| `@types/pg` | `8.23.1` | [Postgres type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pg) |
| `vitest` | `5.0.3` | [Vitest guide](https://vitest.dev/guide/) |
| `vite` | `8.3.4` | [Vite guide](https://vite.dev/guide/) |
| `@playwright/test` | `1.64.0` | [Playwright installation](https://playwright.dev/docs/intro) |
| `@biomejs/biome` | `2.5.15` | [Biome quick start](https://biomejs.dev/installation/quick-start/) |
| `tsx` | `4.23.15` | [tsx official repository and documentation](https://github.com/privatenumber/tsx) |
| `@types/node` | `24.19.2` | [Node type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |
| `@types/react` | `19.3.0` | [React type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react) |
| `@types/react-dom` | `19.3.0` | [React DOM type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom) |

Use native `fetch`, `crypto` and `Intl` rather than adding HTTP, ID or currency-format libraries. Vite is a Vitest dependency, not a second frontend. Use Radix directly with local Tailwind components; a separate UI code generator is not required.

The metadata checks confirmed the selected Node major satisfies the listed Next.js, Vitest, Vite and Playwright engines and that React/React DOM pins align. They are not an installation test. During scaffolding, install the exact versions, commit `package-lock.json`, then run the required checks. If a real incompatibility is found, document the evidence and minimal version adjustment before changing this baseline.

Some Drizzle documentation currently shows `@rc` install commands and newer APIs. Keep the stable pins above and verify API availability against the [tagged 0.45.4 source](https://github.com/drizzle-team/drizzle-orm/tree/0.45.4) or installed types during implementation.

## Server configuration

Document these in a future `.env.example` with empty credential placeholders. Never put provider credentials in `NEXT_PUBLIC_*` variables or commit real values.

| Variable | Purpose/default |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres application URL; required in both modes |
| `DATABASE_DIRECT_URL` | Direct Postgres URL for migrations |
| `TEST_DATABASE_URL` | Separate test database; integration tests must refuse the application database URL |
| `APP_ORIGIN` | Deployed HTTPS origin or `http://localhost:3000` locally; used for mutation-origin checks |
| `PROVIDER_MODE` | New-session default: `rehearsal`; explicitly set `sponsor` after integration checks |
| `DEMO_CONTROLS_ENABLED` | `true` for the hackathon demo; controls operate only on that session's seeded actors |
| `NESSIE_BASE_URL` | `https://prod-api.nessieisreal.com` (verified October 10, 2026); a trailing slash is accepted |
| `NESSIE_API_KEY` | Server-only Nessie key, sent using the provider's query parameter |
| `SNOWFLAKE_ACCOUNT_URL` | Account URL `https://<account-identifier>.snowflakecomputing.com`; a bare host is accepted and given `https://` |
| `SNOWFLAKE_PAT` | Programmatic access token with the required permitted role |
| `SNOWFLAKE_ROLE` | Selected SQL role; configure the user's default role appropriately for Cortex |
| `SNOWFLAKE_WAREHOUSE` | Warehouse for SQL queries; small demo warehouse with auto-suspend configured |
| `SNOWFLAKE_DATABASE` | Suggested `COMMONCART`; create during integration setup |
| `SNOWFLAKE_SCHEMA` | Suggested `DEMO`; all analytical rows remain session-scoped |
| `SNOWFLAKE_MODEL` | `claude-haiku-4-5`; verify availability and access in the actual account |
| `RUN_LIVE_SPONSOR_CHECKS` | `false` by default; explicitly `true` for the live verification command |

Session mode is persisted. Changing `PROVIDER_MODE` affects new sessions only. Missing sponsor configuration must fail sponsor-session creation explicitly; it must not downgrade the session. Runtime code loads Node environment variables on the server, and CLI scripts use Node's environment-file support.

## External API contracts and evidence

### Capital One Nessie

- Reference: [live documentation and quick start](https://prod.nessieisreal.com/docs), [authentication](https://prod.nessieisreal.com/docs#authentication).
- Public documentation observed during planning describes a banking simulation with customers, accounts, bills, transfers, purchases and merchants. Authentication uses `?key=...`.
- The rendered API reference identifies `https://prod-api.nessieisreal.com` as its server. The HackNC page points to the older `api.nessieisreal.com` host; confirm the appropriate sponsor host before using credentials.
- Documented setup operations include `POST /customers`, `POST /customers/{id}/accounts`, `POST /accounts/{id}/deposits`; the quick start also shows `POST /accounts/{id}/transfers`. Account reads include `GET /accounts/{id}` and `GET /customers/{id}/accounts`.
- Read-back references include `GET /transfers/{transfer_id}` and the documented singular `GET /purchase/{purchase_id}`. Validate actual responses rather than mechanically pluralizing paths.

**Observed with authenticated calls, October 10, 2026, `https://prod-api.nessieisreal.com`** (`npm run verify:sponsors`). These observations replace the earlier assumptions:

- `POST /customers` and `POST /customers/{id}/accounts` return `201` with `objectCreated._id`. `GET /accounts/{id}` returns `balance` and `account_number`. `PUT /accounts/{id}` requires `nickname` and cannot set `balance`.
- `POST /merchants` requires `category` as a **string** (an array is rejected with a pydantic validation error).
- `POST /accounts/{id}/transfers` requires `status` and accepts only `status`, `amount`, `transaction_date` and `description`; `medium`, `payee_id` and every other payee field name tried are rejected as extra fields. The transfer record therefore has **no payee**.
- `status` is stored exactly as sent (an arbitrary value such as `bogus` is accepted) and is never advanced by the service. `PUT /transfers/{id}` can change it.
- **Balances never change.** After completed transfers, withdrawals, deposits and purchases, `GET /accounts/{id}` still returns the opening balance.
- Amounts are stored as integers: a `10.5` withdrawal was stored as `10`.
- `GET /transfers/{id}` returns the identifier as `id` (not `_id`). `GET /purchase/{id}` works; `GET /purchases/{id}` returns `403 Missing Authentication Token`. Purchases record `payer_id` equal to the paying account.
- `GET /accounts/{id}/transfers` and `GET /accounts/{id}/purchases` list records with their descriptions; an account with no transfers returns `404 "No transfers found for this account"`.
- The OpenAPI document is not publicly served (`/openapi.json` returns 403); the docs site's reference describes fields only.

- **Bills (observed October 11, 2026).** `POST /accounts/{id}/bills` requires `status`, `payee` and `payment_amount` (fractional values accepted) and returns `201` with `_id`, `account_id`, `creation_date` and `upcoming_payment_date`. `GET /accounts/{id}/bills` returns `[]` when there are none.
  - A bill created **without `recurring_date`** is accepted, but every later `GET /accounts/{id}/bills` for that account fails with `400 "2 validation errors for Bill"` (`recurring_date`, `upcoming_payment_date` missing). Always send `recurring_date`.
  - `upcoming_payment_date` rolls a bill whose recurring day equals today's UTC date to the next month. Use the `payment_date` we set as the due date.
  - Bills do not change the balance.

Adapter decisions based on these observations (`src/server/providers/banking/nessie.ts`):

- Amounts are recorded as integer **cents** (CommonCart's convention, since the service stores integers and moves no money); each description carries the formatted dollar amount.
- A contribution, return or purchase is one record on the paying account with `status: "completed"`. Descriptions start with the operation correlation and include the destination (`CommonCart <key> | to:<account> | $15.00`).
- Correlation lookup is verified: a lost response is recovered by listing the paying account and matching the description prefix.
- `capabilities.balanceEffects` is false, so effective balances are the Nessie opening balance adjusted by confirmed records (`src/server/services/balance-service.ts`). Before purchase every confirmed record is re-read by ID and its amount and status compared; any mismatch blocks readiness (`provider_record_mismatch`).

Use a typed adapter to normalize provider amounts and statuses. Native retry behavior is not assumed. Do not promise real escrow, a real merchant order, automatic refunds or immediate settlement.

### Snowflake SQL API

- [SQL API overview](https://docs.snowflake.com/en/developer-guide/sql-api), [authentication](https://docs.snowflake.com/en/developer-guide/sql-api/authenticating), [submitting requests](https://docs.snowflake.com/en/developer-guide/sql-api/submitting-requests), [handling responses](https://docs.snowflake.com/en/developer-guide/sql-api/handling-responses).
- Submit statements to `POST /api/v2/statements` on the account URL using PAT authentication and the configured role/warehouse/database/schema. Use the documented statement handle/status URL to retrieve asynchronous results.
- Use parameter bindings for values and validated server-configured identifiers. Parse result metadata/types and result partitions explicitly; do not assume every response is an immediately completed array of rows.
- Create analytical tables for versioned offers, needs, proposals and operation summaries. Key rows by session/entity identity and prevent older synchronization events from overwriting newer versions.
- Use idempotent upsert semantics and documented SQL API request identifiers for retry/reconciliation. Data needed for a sponsor-mode match must be synchronized before querying; selected rows are still revalidated against Postgres.

Actual account creation, PAT scope/network policy, warehouse access, table privileges, hosted request reachability and query behavior remain unverified. The setup gate records observed results. Snowflake is a managed service; no fictional server patch version is pinned here.

### Snowflake Cortex REST

- [Cortex REST reference](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api), [PAT guidance](https://docs.snowflake.com/en/user-guide/programmatic-access-tokens).
- Use native `fetch` to `POST /api/v2/cortex/v1/chat/completions` on the account URL with `Authorization: Bearer <PAT>` and JSON input. No direct OpenAI/Anthropic account or SDK is required for this baseline.
- Default model: `claude-haiku-4-5`. The model is documented, but this project's account/region access is not verified. A failed access check is an explicit integration issue; record any chosen supported replacement before changing the default.
- The documented Cortex authorization path uses the user's default role with `SNOWFLAKE.CORTEX_USER` or `SNOWFLAKE.CORTEX_REST_API_USER`. A SQL request's role setting alone does not establish Cortex access.
- Start with non-streaming, short proposal explanations to reduce UI complexity. Validate the response and keep authoritative prices and savings outside model-generated prose. Do not implement a free-form financial agent in the MVP.
- Handle timeouts and rate limits without changing provider mode. A failed explanation does not invalidate a deterministic proposal; show its numbers and a clear retry state.

### Retail data

- [Walmart developer portal](https://developer.walmart.com/), [Marketplace All items](https://developer.walmart.com/us-marketplace/reference/getallitems), [Sam's Club advertising developer portal](https://developer.samsclub.com/).
- Walmart's documented Marketplace catalog access is partner-oriented. Sam's Club's public portal describes advertising integrations. These sources do not establish access to all consumer grocery prices or club membership verification.
- No public Costco/Sam's Club consumer membership API has been verified for this project. Simulate eligibility in fixtures and label it accordingly.
- Default to versioned fictional offers for all three retailers. A 45-minute stretch may import an accessible public product-page observation with source, store/location context, retrieval time and unambiguous quantity/price. Stop on access blocks or ambiguous extraction.
- Scraped price data is an observation, not guaranteed live inventory or a complete checkout quote. Unknown fees/baselines must not be silently treated as zero. The seeded fixture scenario may explicitly define zero demo fees/tax.

## Integration evidence register

| Check | Current evidence | Required completion evidence |
| --- | --- | --- |
| Package release metadata | **Observed Oct 10, 2026:** exact-version install with committed lockfile; `npm ci`, typecheck (`next typegen` + TypeScript 7.0.2 `tsc`), lint, tests and `next build` (Next 16.4.0 with Turbopack, which ran its TypeScript step on TS 7.0.2) all pass. Local runtime was Node 25.8.1 (`EBADENGINE` warning against `24.x`); Node 24.21.0 compatibility not yet re-run | Re-run the suite on Node 24.21.0 |
| Hosting compatibility | Vercel docs list Node 24.x; Neon documents Postgres 18 support. Local Docker `postgres:18` applies the migration and passes integration tests | Actual deployed runtime/database version and working application connection |
| Nessie capabilities | **Verified Oct 10, 2026** (see observations above): provisioning, contribution, return and purchase records read back by ID and by correlation lookup; the full funded-dropout journey ran through the application services against live Nessie (session `ses_…`, seven confirmed records, status `fulfilled`, $28 saved) | Re-run before the demo; record any change in behavior |
| Snowflake SQL | **Blocked:** on Oct 10, 2026 the PAT returned `401` code `390432` "Network policy is required"; on Oct 11 the account returned `401` code `390507` "Your account has been locked." The candidate, demand and four insight statements are unit-tested with fake responses only | A network policy (or authentication policy) for the PAT user, then a successful `verify:sponsors` run and `npm run snowflake:setup` |
| Cortex | **Blocked Oct 10, 2026** by the same PAT network-policy error (`401`) | Successful response through the configured Snowflake account and default role |
| Retail scraping | No scraping attempted | Inspectable source observation and validated imported offer, or keep fixtures |
| Club membership | No verification integration established | Remains explicitly simulated for MVP |

Append observations with date, environment, redacted request/operation reference, outcome and limitations. Keep keys, tokens and personal account data out of this file.
