# CommonCart — Project Brief

Working title: **CommonCart**  
Hackathon: **HackNC**  
Target sponsor tracks: **Best Use of Nessie with Capital One** and **Best Use of Snowflake API**  
Status: Agreed scope for a **24-hour hosted demo**; the full journey is implemented and tested in rehearsal mode. Hosting and live sponsor verification are pending.

Implementation guides: [agent instructions](AGENTS.md), [system atlas](atlas.md), [implementation milestones](implementation.md), [conventions](conventions.md) and [technical context](techContext.md).

## Project description

CommonCart helps everyday consumers buy groceries and household essentials together when doing so offers a better deal than buying separately. It connects people with compatible needs, divides bulk packages into useful shares, and proposes groups whose individual contributions fit each participant's budget.

The central promise is: **Get the savings of buying together without needing the whole package or fronting everyone else's money.**

Someone might need only four rolls of paper towels, have limited storage, or be unable to pay for an entire bulk package. Another nearby shopper may need the remaining quantity. CommonCart identifies an arrangement that works for both, explains the costs, coordinates commitments and pickup, and demonstrates funding through Capital One's Nessie banking sandbox.

Neon Postgres owns the operational records and funding workflow. Snowflake holds synchronized demand, product offers and analytical data used to evaluate possible groups. Snowflake Cortex turns calculated results into clear explanations. Our application performs the actual allocation, optimization and transaction coordination. The MVP uses structured need entry; interpreting free-form shopping lists is a later extension.

The selected stack is a single TypeScript Next.js App Router application deployed on Vercel, with Neon Postgres 18, server-side Nessie and Snowflake REST integrations, and a friendly shopping-club interface. Exact package pins and documentation links live in [techContext.md](techContext.md).

## The consumer problem

Bulk pricing can offer savings while imposing requirements that a single household cannot meet: a larger upfront payment, more quantity than needed, storage space, or access to a membership retailer. Informal group purchases introduce their own problems: finding participants, agreeing on shares, collecting payments and dealing with someone dropping out.

CommonCart treats affordability as a coordination problem. It considers the quantity a person actually needs, their contribution limit, location and pickup preferences, and the constraints of a specific retail offer.

The initial audience is students, roommates and nearby households purchasing repeat-use essentials. Shelf-stable groceries and sealed, countable household items make useful first examples because their shares can be defined clearly. Expanding to perishable or variable-weight goods introduces additional handling and allocation questions.

## What makes the approach distinctive

- **Useful shares:** A cheaper unit price only matters if participants can use the quantity they receive.
- **Individual affordability:** Each participant sets a contribution limit. Optional mock-account checks consider a user-selected bill buffer; account balance alone does not define affordability.
- **Net savings:** Compare equivalent quantities and include known taxes, fees and fulfillment costs. Clearly distinguish estimates from confirmed amounts.
- **Feasible groups:** Quantity, budget, offer eligibility, location and pickup constraints all affect whether a group works.
- **Recovery from disruption:** Recompute the plan when an offer changes, a participant leaves or a contribution fails.
- **Transparent explanations:** Show the source offer, allocation, individual cost and comparison baseline behind each recommendation.

## Core user journey

1. **Choose a demo persona and state a need.** Select a product, exact quantity, contribution limit and pickup slot. Each visitor has an isolated session with seeded shoppers and separate mock banking accounts.
2. **Review a group proposal.** See the product, total package quantity, personal share, estimated contribution, estimated savings, organizer and pickup plan.
3. **Commit to the terms.** Confirm the proposed allocation and cost ceiling. A pledge is not yet a payment.
4. **Fund the group.** After the group is complete and terms are reconfirmed, initiate simulated Nessie contributions to a designated collection account.
5. **Confirm readiness.** Reconcile contribution statuses and recheck the offer before recording a simulated merchant purchase.
6. **Coordinate pickup.** Show each participant's allocation and a simple pickup confirmation workflow.
7. **Handle a funded dropout.** Pause purchasing, return the departing shopper's confirmed contribution, and find a replacement for the same quantity and amount. Existing participants keep their terms. If the offer changes, cancel and return contributions before forming a new proposal; if no replacement exists, show the unresolved group and offer cancellation.

## Retail product and membership data

The MVP uses clearly labeled **fictional retail fixtures representing Walmart, Costco and Sam's Club**. Live retail access is not a prerequisite. The same normalized offer model can later accept authorized APIs, partner data or an inspected public product-page observation.

Desired product fields include product identifiers, retailer and store, package quantity, unit of measure, price, availability, offer expiration, fulfillment costs, minimum quantities and membership requirements. Each offer should retain its source and retrieval timestamp.

The savings mechanisms are scoped as follows:

- **MVP — sharing one bulk package:** Participants divide a fixed package and its complete cost. This does not require a special group-buy discount.
- **Later — explicit quantity discounts:** Apply documented offer tiers only when the retailer actually supplies such a rule. Do not infer additional discounts merely because more people join.

Club eligibility is simulated through labeled persona flags in the demo. Future opt-in membership integrations may help determine whether an organizer can purchase under a retailer's rules. Actual membership sharing or group-purchase eligibility is not assumed; it must be checked for the specific retailer and purchasing arrangement.

### Access assumptions to verify

As of October 10, 2026, Walmart's official developer portal emphasizes seller, supplier and partner APIs. Its documented “All items” endpoint retrieves a partner's catalog; this is not evidence of unrestricted access to all consumer grocery prices. Sam's Club's public developer portal documents advertising partner capabilities, which do not establish access to consumer membership data. Public Costco and Sam's Club membership-verification APIs have not been verified for this project.

Retail integrations are therefore planned capabilities, not confirmed dependencies. After the complete demo and checks pass, timebox a scraping experiment to **45 minutes** against one accessible public product page. Preserve the source URL, store/location context and observation timestamp; stop on access blocks or ambiguous extraction. Validate imported quantities, fees and comparison data before claiming savings. The demo continues to support fixtures regardless of the experiment's outcome.

## Capital One Nessie's role

Nessie supplies the mock banking environment that makes the funding workflow concrete:

| Resource | Role in CommonCart |
| --- | --- |
| Customers and accounts | Associate demo participants with mock funding accounts. |
| Account balances and bills | Evaluate contributions against explicit spending limits and optional user-selected bill buffers. |
| Transfers | Demonstrate collection of contributions and return transfers when a group cannot proceed. |
| Purchases | Record the simulated merchant purchase and link it to the group order. |
| Merchants | Associate retailer offers and transactions with merchant records where appropriate. |

The application owns group membership, pledges, order records and settlement rules. Nessie does not provide retail inventory, group matching, fulfillment or real escrow. A separate collection account for each group represents pooled funds in the sandbox.

Verify the sponsor-provided API host, transfer and purchase write operations, transaction statuses and balance-update behavior before building the funding flow. Distinguish a recorded request from a confirmed contribution in both the UI and application state.

## Snowflake's role

Snowflake is the analytical foundation for combining consumer demand with retail offers:

- Store normalized offers, price snapshots, shopping needs, group proposals and transaction references.
- Query compatible demand by product, quantity, location, pickup window and contribution limit.
- Calculate comparison prices, allocation costs and group outcomes.
- Supply candidate data to an application optimizer that selects feasible groups.
- Use **Snowflake Cortex through a Snowflake API** to explain computed proposals, tradeoffs and changes.

Optional later extensions include natural-language shopping input, Cortex Search over retailer offer terms and natural-language exploration of aggregate savings. The MVP requires Snowflake SQL queries and Cortex REST explanations.

Money calculations and feasibility decisions remain deterministic. Model-generated explanations must use the actual calculated allocations and source offers. An LLM does not decide whether funds moved or invent a discount.

## Matching and allocation requirements

A feasible MVP proposal contains two to six shoppers buying one package of one SKU. Requested integer quantities must fill the package exactly with no leftovers. Participants share a pickup zone and time window; each allocation satisfies product acceptance, contribution limits, availability and configured mock membership requirements.

The deterministic optimizer considers the initiating need and up to 11 other compatible outstanding needs. It allocates total cost proportionally by quantity, distributes rounding pennies by largest remainder and stable IDs, and requires positive savings for every participant against a supplied comparable baseline. Rank feasible proposals by total savings, then request age and stable IDs.

Explain why the selected group fits the shopper's constraints. Route optimization, alternative pickup tradeoffs and variable quantities are later extensions. Revalidate selected records in Postgres before committing a proposal.

## Transaction and application responsibilities

The workflow distinguishes shopping demand, confirmation, funding, returning a contribution, seeking a replacement, purchase readiness, purchase dispatch, purchase completion, pickup and cancellation. Group status and individual banking-operation status remain separate; [implementation.md](implementation.md) defines their exact names and transitions.

Multiple banking calls can partially succeed. The backend must reconcile results, prevent duplicate operations on retries and track return transfers explicitly. A failed group does not imply an automatic rollback of prior banking operations.

Durable workflow state belongs in Neon Postgres 18, accessed through Drizzle and `pg`. Record operations and synchronization work before dispatching external requests. Use short database transactions and keep provider calls outside them. Unknown banking outcomes require reconciliation rather than blind retries. Snowflake receives versioned analytical records and does not provide an atomic transaction across external Nessie calls.

Sessions explicitly select **sponsor** or **rehearsal** mode. Sponsor mode uses real Nessie sandbox and Snowflake API calls; rehearsal uses fixture-backed local providers. Mode is fixed for the session, and a failed sponsor request never silently becomes mock success. Reset creates a new session while retaining prior transaction evidence.

Participants see group allocations and confirmed contribution statuses. Other participants' account balances, bills and detailed histories remain private. External API credentials stay on the server.

## Proposed UI

- **Persona and need entry:** Select a seeded shopper, product, exact quantity, contribution ceiling and pickup slot.
- **Group proposal:** Product image, package size, allocated shares, contribution breakdown, source price and savings comparison.
- **Funding progress:** Clear distinction between pledges, pending contributions and confirmed funds.
- **Changes:** Revised proposals with an explanation of why they changed and an explicit confirmation step.
- **Pickup and outcome:** Allocation checklist, pickup confirmation and final cost record.

The interface uses warm neutral backgrounds, green savings accents, readable product cards and accessible dialogs. It explains quantities, costs and next actions in everyday language. A session-scoped operator panel can advance synthetic participants through the demo and show provider status.

## Hackathon MVP and demo

The first version demonstrates a single complete journey with a small catalog, six seeded shoppers, one pickup area and simple countable goods. It runs at a hosted URL on Vercel, with persistent state in Neon.

Illustrative demo prices are fixtures, not claims about current retail prices: four shoppers share a 24-unit, $60 package at six units and $15 each, compared with an equivalent $22 purchase each. The fixture explicitly sets demo taxes and fees to zero, yielding $7 savings per participant. The general calculation includes all known price components.

The demo should then show:

1. Alex enters a need. Taylor's $12 contribution limit excludes them from a $15 share; the initial group is Alex, Jordan, Sam and Riley.
2. All four confirm their terms. Alex and Jordan each contribute $15, bringing collected mock funds to $30.
3. Jordan leaves before purchase. A confirmed $15 return reduces collected funds to $15 and Jordan's net contribution to zero.
4. Casey accepts Jordan's exact share, then Casey, Sam and Riley fund their allocations. Retained contributions reach $60 without changing existing members' prices.
5. A confirmed simulated purchase produces four allocations and $28 total savings, followed by pickup confirmations.

The featured disruption is funded dropout and replacement. Cancellation reuses the return-transfer mechanism when no replacement is available. Unknown or failed returns block purchase rather than being presented as completed refunds.

## Later expansion

Potential extensions include authorized live retail and membership connections, recurring purchasing circles, multi-product baskets, split-package logistics, organizer reliability and better matching across pickup areas.

Live merchant checkout, real payment processing and guaranteed fulfillment are later capabilities. The hackathon demonstrates the coordination and financial workflow through mock banking and explicitly identified retail data sources.

## Success criteria

- Explain the value to an everyday consumer in one sentence.
- Produce a group with valid allocations and positive estimated net savings.
- Keep every proposed contribution within the participant's confirmed limit.
- Demonstrate Nessie banking operations as a core part of the journey.
- Demonstrate meaningful Snowflake queries and a grounded Cortex explanation.
- Recover visibly from the chosen disruption scenario without losing track of contributions.
- Identify live, estimated, self-reported and simulated data clearly.

## References

- [HackNC track descriptions](https://past-cushion-a6f.notion.site/HackNC-Tracks-756816442900834e900c016919f003e8)
- [Capital One Nessie documentation](https://prod.nessieisreal.com/docs)
- [Snowflake Cortex REST API](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api)
- [Snowflake SQL API](https://docs.snowflake.com/en/developer-guide/sql-api)
- [Walmart developer portal](https://developer.walmart.com/)
- [Walmart Marketplace: All items](https://developer.walmart.com/us-marketplace/reference/getallitems)
- [Sam's Club advertising developer portal](https://developer.samsclub.com/)
