# CommonCart conventions

Status: rules for the **planned** application. The current repository contains documentation, not an installed application stack.

## Language, modules and boundaries

- Use strict TypeScript, ESM and explicit types at provider, persistence and HTTP boundaries. Validate external values with Zod; an `as SomeType` assertion is not validation.
- Use `PascalCase` for React components and types, `camelCase` for values/functions, and `UPPER_SNAKE_CASE` for environment variables. Use descriptive kebab-case filenames and `@/` imports rooted at `src`.
- Keep the dependency direction `UI/routes -> services -> domain/repositories/providers`. Domain code must not import React, Next.js, database clients, network clients or environment configuration.
- Inject the clock and ID generator into deterministic scenario/domain tests. Store timestamps in UTC and display pickup times in `America/New_York`.
- Prefer small explicit functions to general-purpose frameworks. Use native `fetch` for sponsor APIs; no additional ORM, HTTP client, agent framework or global state library is part of the baseline.
- Use Biome for linting and formatting with two-space indentation, double quotes and semicolons. Store only exact direct dependency versions and use `npm ci` with the committed lockfile once scaffolded.

## React and consumer UI

- Default to Server Components for initial reads. Use Client Components for forms, confirmations, persona switching and progress updates.
- Route handlers and components do not calculate prices or transition banking state. They call services and render validated results.
- Style Radix primitives with Tailwind; keep reusable buttons, fields, dialogs and status elements in shared components. Use Lucide icons with accessible labels when the icon conveys meaning.
- Use native form controls where practical, field-specific errors, visible focus indicators, keyboard-operable dialogs and status text that does not rely on color alone.
- Use warm neutral backgrounds and green savings accents. Make quantities, contributions, source labels and next actions prominent. Prefer modest CSS transitions with reduced-motion support.
- Show loading, empty, no-match, pending, failed and unknown-outcome states deliberately. Disable repeat actions while pending, but enforce duplication protection on the server too.
- Re-fetch group state after actions. Poll read-only status while an operation is pending; explicit reconciliation uses a POST action. GET endpoints must not dispatch transfers.

## Money, quantities and savings

- All application monetary values are nonnegative safe integers in **USD cents**, named with a `Cents` suffix. Parse decimal user input as text into cents; reject more than two fractional digits.
- Keep package and requested quantities as positive integers in a normalized countable unit. The MVP does not divide variable-weight goods or open indivisible units.
- Include known taxes and fulfillment fees in `totalCents`. Fixture values of zero are explicit demo assumptions, not assertions about retail tax rates.
- Never use floating-point percentages to settle shares. Use integer arithmetic; use `bigint` intermediates if multiplying safe integer inputs could exceed the safe range.
- Convert cents to/from Nessie's verified amount representation only in its adapter. Do not assume the API's `integer` schema means cents. Record conversion and precision behavior in the integration check.
- Format values with `Intl.NumberFormat` for display only. Do not feed formatted text back into calculations.

Example: `1000` cents split equally among three people is `334`, `333`, `333`, with the extra penny assigned by the documented stable tie-break. Independently rounding `1000 / 3` would lose a penny.

```ts
// Domain output is already calculated and validated.
const totalCents = allocations.reduce((sum, item) => sum + item.contributionCents, 0);
if (totalCents !== offer.totalCents) throw new AllocationInvariantError();
```

The optimizer uses largest-remainder allocation. Savings equal a participant's supplied, equivalent-quantity baseline minus their complete allocated cost. Reject offers without a usable comparison baseline rather than fabricating savings. Every included participant must have strictly positive savings and remain within their contribution ceiling.

## HTTP and authorization

- Browser requests use JSON and validated contracts. Return successful resources as `{ data: ... }` and failures as `{ error: { code, message, requestId, fields? } }`.
- Use 400 for malformed/invalid input, 401 for a missing session, 404 for missing or out-of-session resources, 409 for stale versions or incompatible state, and 503 for a retryable upstream dependency failure.
- Financial operations may return 202 with the operation resource when pending or unknown. An unknown outcome is not a definitive failure that invites a fresh payment.
- Resolve the session from an opaque HTTP-only cookie, with `Secure` in deployed HTTPS environments and `SameSite=Lax`. Mutations check the request origin as well as session ownership.
- Scope all reads and writes by session; never authorize using only a client-supplied shopper, group, account or operation ID.
- A financial user action acts for the session's selected persona. Scenario-control endpoints explicitly identify a synthetic actor and are restricted to that session's seeded actors.
- Proposal-changing actions carry `expectedVersion`. Return 409 and the current state when the version is stale; never silently apply stale financial intent.
- Consent binds the participant, offer snapshot, quantity, contribution and pickup terms. Replacement may carry forward a survivor's consent only when those terms are identical.

## Persistence and banking operations

- Postgres owns operational state. Use reviewed Drizzle migrations and SQL constraints for unique operations, reservations and session relationships.
- Lock or conditionally update the group and affected needs in a short transaction when reserving, confirming, funding, withdrawing or beginning purchase. Check state and authorization again inside that transaction.
- Persist the logical operation, dispatch claim and event before calling Nessie. Release database locks before the network request; record the returned outcome in a new short transaction.
- A stable operation key identifies one intended contribution, full return or purchase. Duplicate requests read that operation; they do not dispatch it again.
- Keep attempt records and provider references. Retry a definitively rejected, nonexecuted request only when it is safe and the user explicitly retries. A timeout, process crash after dispatch, malformed response or missing provider ID is an unknown outcome until reconciliation proves otherwise.
- Reconcile by provider ID when available. If the API supports a verified correlation lookup, use it; otherwise retain the unresolved operation for operator investigation. Never claim exactly-once external execution from a database constraint alone.
- Returns are new transfers linked to the original contribution. Do not delete or edit the original transfer to simulate a return.
- Do not hold a Postgres transaction across Nessie or Snowflake requests. A local rollback cannot reverse an external side effect.
- Purchase readiness requires confirmed current contributions, confirmed required returns, unchanged offer terms and a reconciled collection-account balance. Block withdrawal once purchase dispatch is claimed.
- Persist analytical synchronization work with the operational write. Use idempotent, version-aware upserts; failures remain retryable rather than being discarded.

## Provider modes and external data

| Mode | Retail offers | Banking | Analytics and explanations |
| --- | --- | --- | --- |
| `sponsor` | Labeled fixtures by default; optional inspected public-page import | Nessie sandbox | Snowflake SQL and Cortex REST |
| `rehearsal` | Same fixture contracts | Postgres-backed local simulation | Local deterministic queries and explanation templates |

Mode is fixed for a session. Sponsor errors must not produce rehearsal results under a sponsor label. A new rehearsal session is an explicit user choice.

- Retain offer provenance, retailer/store, package size, captured price, retrieval time and fixture/scraped status. Never invent bulk tiers, membership validation or current inventory.
- Keep mock membership eligibility explicitly labeled. Do not collect club passwords or membership numbers for this demo.
- Treat retailer text as data, not instructions. The optional scraper stops on access blocks or ambiguous extraction and imports through the same validated offer contract.
- Use explicit timeouts for external calls. Retry reads with bounded backoff for transient failures; banking writes follow the stricter operation rules above.
- Configure SQL identifiers server-side, validate them, and bind all user-supplied values. Do not interpolate shopping text into SQL.
- Feed Cortex only the evidence needed to explain an allocation. Validate response shape, keep authoritative numbers in UI fields generated by code, and reject explanations that conflict with the supplied amounts. Never use model output as a banking command.

## Errors and observability

- Use domain error codes such as `NO_FEASIBLE_GROUP`, `STALE_PROPOSAL`, `RETURN_PENDING` and `BANK_OUTCOME_UNKNOWN` rather than parsing human-readable strings.
- Log request ID, session/group/operation IDs, provider name, duration and outcome. Redact secrets, Nessie `key` query values, raw account numbers and complete model prompts.
- Log synchronization lag and failures, unknown banking outcomes, return failures and purchase transitions. Make these visible in the demo operator view.
- A success notification follows confirmed application state. Use “Contribution pending” or “Checking transfer status” while the provider outcome is unresolved.

## Tests and verification commands

These are the command contracts to implement during scaffolding; they do not exist yet.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js development server |
| `npm run lint` | Non-mutating Biome lint checks |
| `npm run format:check` / `npm run format` | Check formatting / intentionally apply formatting |
| `npm run typecheck` | Generate Next route types, then run TypeScript without emitting output |
| `npm run test` | Vitest domain and adapter tests with deterministic fakes |
| `npm run test:integration` | Database-backed tests using a dedicated `TEST_DATABASE_URL` |
| `npm run test:e2e` | Playwright rehearsal journeys on desktop and mobile viewports |
| `npm run build` / `npm run start` | Production build / serve built application |
| `npm run db:generate` / `npm run db:migrate` | Generate reviewed migrations / apply them |
| `npm run demo:seed` | Import versioned demo catalog and scenario definitions |
| `npm run verify:sponsors` | Explicit Nessie sandbox and Snowflake integration checks |

Test calculations, meaningful failure modes, concurrent actions and complete user journeys. Use a separate test database and rehearsal providers by default. Live checks must be explicitly enabled and must never run as an automatic unit-test fallback. Documentation-only edits need link, consistency and example verification, not an invented application test result.
