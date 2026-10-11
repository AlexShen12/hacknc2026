# Live Nessie demo: Sam starts a Costco group

Validated through the browser on October 11, 2026 against live Capital One Nessie and the application's Neon database. No real money moves. Membership flags and retail prices are fictional fixtures.

## Preparation

1. Open `http://localhost:3000` with the app running (`npm run dev`). Start **Live mode (Capital One Nessie)** and let provisioning finish before recording. For an existing completed session, **Demo controls → Reset demo (new session)** creates a fresh session with the same mode.
2. Select **Sam** in **Choose demo shopper**. Sam has the simulated Costco membership.
3. Choose **Costco Club Pack Paper Towels**, **Start my own group**, **10 rolls**, maximum contribution **$25.00**, and the only available Costco pickup slot (the second session window; its displayed date/time changes with session creation).
4. Keep **List it for nearby shoppers** selected. Uncheck both **Pay my share automatically** and **Record the purchase automatically**. Click **Start my group**. Sam's terms are already confirmed; no separate confirmation is needed.

## Verified sequence

Wait for each request to finish and the next action to appear before continuing. A visible confirmed status, rather than the click, is the checkpoint.

| Action | Expected result |
| --- | --- |
| Sam starts the group as above | 10 of 30 rolls claimed; Sam pays $23 and saves $12 versus the $35 fixture comparison. |
| Switch to Alex on the same group page; enter 10 rolls and $25 maximum; uncheck auto-pay; click **Join for $23.00** | 20 of 30 rolls claimed. Alex joins without needing a Costco membership; the organizer provides the simulated eligibility. |
| Switch to Jordan; enter 10 rolls and $25 maximum; uncheck auto-pay; click **Join for $23.00** | Package filled; **Collecting contributions**. Joining already records consent. |
| Jordan clicks **Contribute $23.00**; open Demo controls and click **Contribute as Sam** | $46 confirmed of $69; two records verified with Nessie. Alex remains unpaid. |
| In Demo controls click **Leave as Jordan** | A $23 return is confirmed; collection balance falls to $23; Jordan's effective balance returns to $100, net group contribution $0. Purchase is blocked while the share is open. |
| Close controls, select Casey; the **Take the open share** form is prefilled with 10 rolls and $23; uncheck auto-pay and click **Join for $23.00** | Casey replaces Jordan at the identical quantity and price. No separate confirmation is needed. |
| Casey clicks **Contribute $23.00**; Demo controls → **Contribute as Alex** | $69 confirmed of $69; **Ready to purchase**. |
| Demo controls → **Purchase as Sam** | **Purchased — ready for pickup**; effective collection balance $0; six confirmed records verified with Nessie. Alternatively select Sam and click **Record purchase ($69.00)**. |
| Demo controls → **Pick up as Sam**, then Alex, then Casey | **Complete**. Three active shoppers receive 10 rolls each; total fixture savings $36. |

Costco has no seeded replacement request in this scenario, so automatic replacement finds nobody. Casey must join the open share explicitly. Do not use **Join as Alex/Jordan** operator shortcuts to fill the initial group: they may choose a different quantity and enable auto-pay. Use the shopper forms for the initial 10-roll joins.

## Two-minute presentation

The linked submission instructions require a video no longer than two minutes, a GitHub link, and a two-minute fair demo followed by two minutes for questions. Provision beforehand. Target 1:50 and trim actual loading pauses in the recording.

| Time | Screen and narration |
| --- | --- |
| 0:00–0:15 | Sam and the Costco product: “Bulk shopping saves money, but students may not need thirty rolls or want to front sixty-nine dollars. CommonCart lets a member organize useful shares.” |
| 0:15–0:35 | Create group and show joins: “Sam has our simulated Costco membership. Alex and Jordan join for ten rolls each: twenty-three dollars instead of the fixture's thirty-five, saving twelve dollars each.” |
| 0:35–0:55 | Fund Jordan and Sam; show collection verification: “Our backend records contributions through live Capital One Nessie sandbox API calls and reads the records back. Forty-six dollars is confirmed.” |
| 0:55–1:15 | Jordan leaves: “Jordan drops out after paying. We record and confirm the twenty-three-dollar return before accepting replacement funding. Everyone else's terms stay fixed.” |
| 1:15–1:35 | Casey joins; fund Casey and Alex: “Casey accepts the same share. Once sixty-nine dollars is confirmed, the organizer can record the sandbox merchant purchase.” |
| 1:35–1:50 | Purchase, ledger and pickup: “All six banking records are verified with Nessie, including the return and purchase. Three shoppers collect ten rolls each and save thirty-six dollars using our demo prices. Neon preserves the complete workflow.” |

Demo controls act for seeded shoppers through the same services as the consumer UI. Explain that if asked. This is a larger club package, not evidence of a load or multi-group scale test.

## Evidence and caveat

- Observed browser group: `grp_24866ac0-67af-4834-9fa9-8472908ed1e5`, mode `sponsor`, bank `nessie`, analytics `postgres`, database label `Neon Postgres`.
- Final status: **Complete**. Four $23 contributions (including departed Jordan), one $23 return and one $69 purchase; all six records verified with Nessie. Final effective collection balance $0.
- Screenshot: [completed live demo](artifacts/live-costco-demo/completed.jpg).
- The original **Why this group works** paragraph still named Jordan after Casey replaced them. The allocation table and bank ledger correctly showed Casey. Show the table and verified ledger after replacement; do not present that paragraph as the current membership summary.
- Nessie stores records without moving reported balances; CommonCart derives effective balances from confirmed operations. Actual membership verification, retailer checkout and real payments are outside this demo.

Submission reference: [organizer instructions](https://past-cushion-a6f.notion.site/IMPORTANT-Submission-Instructions-648816442900823890388190be1f899e). Use the [2026 Devpost](https://hacknc-2026.devpost.com/) because some Notion links point to 2025.
