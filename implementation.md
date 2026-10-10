# CommonCart implementation guide

Status: **planned; all application milestones are pending**. This guide specifies the later application build. The documentation pass does not provision services, scaffold code or verify authenticated sponsor calls.

Read [atlas.md](atlas.md) for the system map, [conventions.md](conventions.md) for implementation rules and [techContext.md](techContext.md) for exact pins and external API evidence.

## Agreed target

Deliver a hosted, needs-first, 24-hour hackathon demo using one TypeScript Next.js application, Neon Postgres 18, Capital One Nessie and Snowflake SQL/Cortex APIs. Use seeded personas, explicit provider modes and a friendly shopping-club UI. The main demo shows a funded participant leaving, receiving their contribution back, and being replaced without increasing anyone else's contribution.

The MVP uses one SKU and one package per group, exact countable quantities, two to six participants, one seeded pickup zone and shared pickup windows. Retail data and club eligibility are simulated by default. Natural-language shopping, quantity-discount tiers, multi-product baskets, live membership verification, real checkout and real payments are later extensions.

## Milestones and acceptance gates

The hour ranges allocate a 24-hour effort budget; they are planning targets, not claims of completed work.

| Milestone | Target | Deliverables and acceptance gate |
| --- | --- | --- |
| 0. External contracts | Hours 0–2 | Verify Nessie amount units, create/read transfer and purchase behavior, IDs and settlement timing; execute Snowflake SQL and Cortex requests. Record evidence in `techContext.md`. A blocked sponsor capability is explicit; rehearsal development may continue. |
| 1. Foundation | Hours 2–5 | Scaffold pinned dependencies, command scripts, database migrations, provider contracts, fixtures and isolated sessions. Deploy a working persona/need-entry shell to Vercel backed by Neon. `lint`, formatting, typecheck and build pass. |
| 2. Shopping and matching | Hours 5–9 | Validate needs, synchronize analytical inputs, query candidates, calculate proposals and render allocations. Deterministic matching tests pass and the fixture scenario selects the expected group. |
| 3. Funding | Hours 9–14 | Reserve needs, record consent, persist and dispatch contributions, reconcile outcomes and enforce purchase readiness. Duplicate requests and competing actions cannot dispatch duplicate operations. |
| 4. Funded dropout | Hours 14–18 | Return a departing contribution, refill the exact slot, confirm/fund the replacement and complete the purchase. Implement cancellation using the same return primitive. The featured rehearsal journey passes end to end. |
| 5. Presentation | Hours 18–21 | Add grounded Cortex explanations, source labels, pickup summary, operator controls and responsive/accessibility polish. Sponsor mode visibly uses real Snowflake queries and explanations. |
| 6. Verification | Hours 21–24 | Run the full check suite, verify deployed sponsor behavior and rehearse the demo. Record actual limitations and provider status. Attempt scraping only if the complete flow and checks already pass, with a 45-minute limit. |

Mark a milestone complete only with its evidence. Live API checks that cannot be performed remain pending, even when their rehearsal adapters work. No application milestone is complete at document creation.

## Core contracts

Define these as domain types with matching Zod validation at boundaries. Persistent entities have IDs and timestamps; session-owned entities always carry `sessionId`. Monetary fields are integer USD cents. Provider-specific request bodies stay outside these types.

| Type | Minimum information |
| --- | --- |
| `DemoSession` | ID, fixed `sponsor`/`rehearsal` mode, selected shopper ID, scenario version, provisioning status and creation time |
| `Shopper` | Session, display name, funding-account reference, contribution preferences, user-selected buffer, simulated club eligibility |
| `Offer` | Retailer/store, SKU, product family, normalized unit, package quantity, item/tax/fee/total cents, supported comparison baselines, membership requirement, pickup location, availability, version, source kind/URL/retrieval time/expiration |
| `Need` | Session/shopper, accepted SKU IDs, exact quantity, maximum contribution cents, pickup zone/window, status, creation time and revision |
| `Proposal` | Session, offer snapshot, group status, revision, initiating need, organizer, collection-account reference, analytical snapshot and timestamps |
| `Allocation` | Proposal, need/shopper, quantity, contribution/baseline/savings cents, consented terms, contribution/return references, active/departing/replaced/picked-up state |
| `BankOperation` | Session/group/allocation as applicable, contribution/return/purchase kind, logical operation key, amount, account references, status, attempt history, provider IDs, correlation value and error metadata |
| `WorkflowEvent` | Session/group, monotonic group sequence, actor, event type, timestamp and bounded structured payload |

Persist analytical synchronization work in an outbox alongside operational writes, including entity ID, session, entity version and delivery status. Keep per-person consent attributable to the specific offer, quantity, amount and pickup snapshot. A proposal revision is a stale-write guard; it is not evidence that every external transaction settled.

An offer comparison baseline must cover the requested quantity using the same normalized unit and comparable product. The demo supplies exact per-quantity baselines. If a later imported offer cannot supply a valid baseline, it cannot produce a claimed saving.

### Provider contracts

| Contract | Required behavior |
| --- | --- |
| `RetailProvider` | Load normalized offers, retrieve an offer/version and report provenance. The fixture implementation is required; a public-page import is optional. |
| `BankingProvider` | Provision session accounts and group collection accounts; read accounts/bills; submit a contribution, return or purchase; observe an operation; expose verified capabilities. Return normalized IDs/statuses without pretending unsupported lookups exist. |
| `AnalyticsProvider` | Synchronize versioned records, query compatible needs/offers, calculate analytical summaries and explain a validated proposal. Explanations carry their evidence/proposal version. |

Use `native fetch` in the live adapters. Rehearsal banking maintains its own account ledger in Postgres so transfers have actual testable balance effects. Rehearsal analytics uses local data and deterministic explanation templates. Neither mode shares financial records with the other.

### Browser-facing API surface

Use a `/api` prefix. All writes use POST or PATCH; GET is read-only. Return the JSON envelopes and status codes defined in [conventions.md](conventions.md).

| Method and route | Input and result |
| --- | --- |
| `POST /api/demo/sessions` | Requested configured mode; create an isolated session, seed its personas, set cookie and return provisioning status |
| `GET /api/demo/session` | Return current session, selected persona and provider health without secrets |
| `POST /api/demo/persona` | Select a shopper belonging to the current session |
| `POST /api/demo/reset` | Create a new session; retain old operation/audit records |
| `GET /api/offers` | Return available normalized offers and provenance |
| `POST /api/needs` | Create the selected persona's validated need |
| `POST /api/matches` | Initiating need ID; synchronize inputs and return ranked proposals |
| `GET /api/groups/:id` | Return the session-scoped group, allocations and operation summaries |
| `POST /api/groups/:id/confirm` | `expectedVersion`; confirm the selected persona's exact terms and reserve required needs atomically |
| `POST /api/groups/:id/contribute` | `expectedVersion`; return or create the persona's logical contribution operation |
| `POST /api/groups/:id/withdraw` | `expectedVersion`; mark a departure and initiate any required return |
| `POST /api/groups/:id/replace` | `expectedVersion`; query and rank compatible replacements for the vacant fixed slot |
| `POST /api/groups/:id/cancel` | `expectedVersion`; block purchase and return all confirmed retained contributions |
| `POST /api/operations/:id/reconcile` | Observe the provider result and apply permitted progress; never blindly resubmit |
| `POST /api/groups/:id/purchase` | `expectedVersion`; organizer initiates one purchase after readiness checks |
| `POST /api/groups/:id/pickup` | `expectedVersion`; confirm the selected persona's purchased allocation was collected |
| `POST /api/groups/:id/explanation` | Request a grounded explanation for the current proposal snapshot |
| `POST /api/demo/actions` | Run an allowlisted seeded-persona action within the current session; reuse the same services as normal actions |

The selected persona can act only on its own need/allocation. The organizer can purchase or cancel its group. Scenario controls may advance other synthetic personas in that isolated demo but cannot accept arbitrary account IDs or invoke arbitrary provider methods. The session creator can use the demo cancellation action to recover a stranded synthetic group.

## Deterministic matching

1. Validate the initiating need and select compatible offers: accepted SKU, normalized unit, availability, pickup zone/window and mock membership eligibility of an organizer.
2. For each offer, take the initiating need plus at most the 11 oldest compatible outstanding needs, ordered by creation time and ID. Require distinct shoppers and exclude withdrawn, fulfilled or already reserved needs.
3. Enumerate subsets of two to six needs containing the initiator. Accept only subsets whose exact quantities sum to one package. The fixed bound permits straightforward exhaustive search; a solver library is unnecessary for this MVP.
4. Allocate the complete order total in proportion to quantities. Compute floor shares and integer remainders, then distribute residual cents by descending remainder and ascending need ID.
5. For each member, require the allocation to fit its declared maximum and optional available-balance-minus-buffer constraint. Require a supported comparison baseline and strictly positive savings.
6. Choose the initiating shopper as organizer if eligible; otherwise choose the oldest eligible participant. Membership applies to this simulated organizer rule, not a claim about actual club purchasing policies.
7. Rank by total savings descending, then the lexicographically ordered list of member request timestamps and IDs ascending. Use offer ID as the final deterministic tie-break.
8. Before reservation/confirmation, re-read and lock affected Postgres records, verify versions, recalculate the same allocation and reject conflicts. Do not reserve a need in two active groups.

Bank-account checks are snapshots, not holds. Check again before dispatching a contribution. Once a group has confirmed terms, a lower balance blocks its contribution rather than silently changing the amount.

### Replacement matching

After the departing member's return is confirmed, reopen its exact quantity and contribution slot. Query candidates under the same offer, pickup and eligibility constraints. Require the replacement's maximum and available funds to cover the fixed share and its own baseline to show positive savings. Rank by request age then need ID; exclude the withdrawn need.

If the organizer leaves, select an eligible remaining or replacement organizer before readiness can resume. If none exists, the group remains unresolved and can be cancelled. Existing members keep their amounts and consent only when their personal terms are identical. A replacement always provides its own consent.

## State, concurrency and recovery

Use group states `awaiting_confirmation`, `funding`, `returning_contribution`, `replacement_needed`, `ready_to_purchase`, `purchasing`, `purchased`, `fulfilled`, `cancelling` and `cancelled`. `forming` describes persisted shopping demand before a proposal exists. Individual operations use `prepared`, `dispatching`, `pending`, `confirmed`, `failed` and `unknown`.

- Reserve the proposal's needs atomically on its first valid confirmation. Funding starts only after every current participant has consented and the offer is revalidated. Unfunded cancellation releases reservations.
- A contribution action persists a unique operation before dispatch. Only one worker/request can claim it. Requests that lose the claim return its current state.
- Distinguish definite rejection from unknown outcome. A provider response with an ID may still be pending; inspect it using verified status semantics. A timeout after sending bytes or a crash during dispatch becomes `unknown` and blocks incompatible actions.
- Reconciliation reads a known provider operation ID or a verified correlation lookup. If neither is available, retain the unknown state for operator investigation; do not infer success or failure from elapsed time alone.
- If departure is requested while its contribution is pending/unknown, block further group progress and first reconcile that contribution. If it settles, return it; if it definitively never executed, open the slot without a return.
- Funded departure starts a separate full return transfer. Replacement funding waits for that return to confirm. Other confirmed contributions stay attributed to their owners; no second charge is created for them.
- Atomically claim `purchasing` before external purchase dispatch. Concurrent withdrawal is rejected once this claim exists. Reconcile an unknown purchase before allowing a return or a new purchase attempt.
- A changed, expired or unavailable offer blocks purchase. After resolving in-flight operations, cancel and return retained contributions. A new offer creates a new proposal with fresh consent.
- Cancellation resolves all pending/unknown contributions, returns every confirmed unreturned contribution and becomes `cancelled` only when all required returns are confirmed. Failed or unknown returns remain visible and retryable through reconciliation rules.
- Confirm purchase readiness only when all current contributions and required departure returns are confirmed, total retained contributions equal the frozen order total, and the collection-account balance reconciles. Each group uses a separate collection account with no unrelated starting balance.
- Mark `purchased` only from a confirmed provider outcome. Mark `fulfilled` only after all active allocations report pickup.

Use the operation and persistence rules in [conventions.md](conventions.md) for database locks, attempts and event history. Do not implement a fictional cross-system transaction or treat a transfer-delete endpoint as a refund.

## Snowflake and Cortex flow

Mirror offers, active needs, proposal outcomes and operation summaries into session-scoped Snowflake tables. Operational writes append versioned outbox records; a bounded synchronizer uses keyed upserts and marks delivered versions after confirmation. Older records must not overwrite newer ones.

The matching service awaits required synchronization, runs a parameterized candidate query through the SQL API and passes validated rows to the pure optimizer. Persist the input snapshot/version with the proposal. Postgres remains the final authority for reservations and consent. A Snowflake outage returns a retryable sponsor-mode error; it does not silently query rehearsal data.

After a proposal is calculated, send its product, quantities, complete cost, comparison baselines, savings and constraints to Cortex. Request a short explanation of why the group works. Render authoritative numbers directly from the domain output, validate the response shape and refuse conflicting financial claims. If Cortex fails, keep the numeric proposal visible with “Explanation unavailable” and a retry action.

The MVP needs SQL API queries and Cortex REST inference. Cortex Search, Analyst, agents and a vector database are not required. Store source/query IDs for the operator demo so real sponsor calls can be demonstrated without revealing credentials.

## Fixture catalog and featured scenario

Create three product families: paper towels, shelf-stable snack bars and sealed trash-bag packs. Supply one fictional, labeled offer per family for Walmart, Costco and Sam's Club. These are generic fixture products with local illustrations, not claims about actual prices, inventory or club policy.

Every offer includes its SKU, package count, complete price components, comparable per-quantity baseline, mock availability, pickup data, membership flag, fixture version and timestamp. Fixture expiry is relative to session creation so the demo is repeatable; the operator can explicitly trigger an expired-offer test. Club eligibility comes from seeded persona flags and is labeled simulated.

For the featured Walmart paper-towel offer, use a 24-unit package priced at **6000 cents**, with **0 cents demo tax** and **0 cents demo fees**. Six units bought separately have a fixture baseline of **2200 cents**. Four people each receive six units for 1500 cents and save 700 cents.

| Persona | Requested units | Maximum contribution | Purpose |
| --- | --- | --- | --- |
| Alex | 6 | 2000 cents | Initiator and organizer |
| Jordan | 6 | 2000 cents | Funded participant who leaves |
| Sam | 6 | 2000 cents | Original member |
| Riley | 6 | 2000 cents | Original member |
| Casey | 6 | 2000 cents | Later request; replacement |
| Taylor | 6 | 1200 cents | Excluded by budget |

Set each initial funding balance to 10000 cents and the selected buffer to 2000 cents. Allocate request timestamps so the initial group is Alex, Jordan, Sam and Riley; Casey is later. Nessie initialization must represent these cents using the adapter's verified unit conversion. Create a fresh zero-balance collection account for the group.

### Operator demo script

1. Start a fresh session and select Alex. Create or confirm the prefilled six-unit need. Show Taylor's budget exclusion and the initial four-person allocation.
2. Advance each initial participant through confirmation using session-scoped demo controls. Show the source offer, quantity split and 700-cent personal saving.
3. Confirm Alex's and Jordan's 1500-cent contributions. The collection account contains 3000 cents.
4. Have Jordan leave. Pause purchasing and display the return operation. After its confirmation, the collection account contains 1500 cents and Jordan's net contribution is zero.
5. Match Casey to the vacant six-unit, 1500-cent slot. Confirm Casey's terms, then fund Casey, Sam and Riley. Retained contributions total 6000 cents.
6. Alex records the simulated purchase. After confirmation, show four six-unit allocations, 2800 cents total savings and the reconciled collection account.
7. Mark the four pickups to finish the journey. The operator view retains all contribution, return and purchase references.

Do not advance a live Nessie step merely because the operator presses the next button. If the provider settles asynchronously, show pending status and reconcile it. Rehearsal controls may simulate timing and failures explicitly.

## Retail scraping stretch

After the complete demo and checks pass, timebox one public product-page experiment to 45 minutes. Use the pinned Playwright tooling if rendering is necessary; otherwise use a simple server-side fetch and explicit parser. Do not add a crawler service to the MVP.

Extract only a clearly visible product identifier/name, package quantity/unit, price, retailer/store context and observation time. Stop on access blocks, authentication requirements or ambiguous price/quantity. Import through `RetailProvider` with `sourceKind: "scraped"`, retain the URL, and require a usable comparison baseline before displaying savings. Do not scrape membership credentials or assume a public page proves checkout availability. All fixture flows remain supported.

## Verification and delivery

Use the command definitions in [conventions.md](conventions.md). No commands are implemented yet.

| Test level | Required cases |
| --- | --- |
| Domain | Exact package fill; groups outside size bounds; no feasible group; budget/buffer exclusion; incompatible pickup; mock membership; positive individual savings; deterministic ties; largest-remainder conservation |
| Provider adapters | Amount-unit round trips; response validation; pending versus confirmed outcomes; 429/timeout handling; missing IDs; redaction; explicit mode selection |
| Database integration | Session isolation; unique reservations; stale revisions; duplicate contribution requests; purchase/withdraw race; outbox retry/version ordering; unresolved outcomes survive restart |
| Workflow | Funded dropout and replacement; pending contribution on departure; failed/unknown return blocks purchase; no replacement; cancellation; offer change after funding; pickup completion |
| Browser | Full needs-first journey at desktop and mobile viewports; persona switching; clear budget exclusion; keyboard confirmation; source/mode labels; repeated clicks; reset isolation |
| Live sponsor checks | Dedicated sandbox accounts and known amount conversion; real Nessie contribution/return/purchase observation; Snowflake synchronization and SQL query; Cortex explanation; deployed request reachability |

Run deterministic tests against rehearsal providers and a dedicated test database. Live checks require explicit credentials and `RUN_LIVE_SPONSOR_CHECKS=true`; record the observed result instead of assuming access. Verify the deployed Node major, database migration state and configured provider mode.

Delivery evidence should include test/build results, the hosted URL, the scenario script, observed sponsor operation/query IDs with secrets removed, and any unresolved limitations. Sponsor-mode readiness requires verified live calls; rehearsal completion alone is insufficient.

## Documentation acceptance

The documentation set is ready when scope, type names, statuses, provider modes, fixture arithmetic, commands and version pins agree across all guides; local links resolve; official reference links are checked or their access limitation is recorded; and planned capabilities are not described as completed integrations.
