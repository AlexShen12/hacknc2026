import { expect, type Page, test } from "@playwright/test";

async function operator(page: Page, action: string, persona: string) {
  const panel = page.getByRole("dialog", { name: "Demo operator" });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Demo controls" }).click();
  const button = panel.getByRole("button", { name: `${action} as ${persona}`, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    panel.getByRole("button", { name: `${action} as ${persona}`, exact: true }),
  ).toHaveCount(0);
}

async function closeOperator(page: Page) {
  const panel = page.getByRole("dialog", { name: "Demo operator" });
  if (await panel.isVisible()) await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
}

test("needs-first journey with a funded dropout and replacement", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start the demo \(rehearsal\)/ }).click();
  await expect(page.getByRole("heading", { name: "What do you need this week?" })).toBeVisible();
  await expect(page.getByText("Hi Alex")).toBeVisible();
  await expect(page.getByText(/fictional retail offers/)).toBeVisible();

  // Prefilled need: 6 rolls of the Walmart paper towels, up to $20.
  await expect(page.getByLabel("How many rolls?")).toHaveValue("6");
  await page.getByRole("button", { name: "Find my group" }).click();
  await expect(page.getByRole("heading", { name: "We found a group" })).toBeVisible();
  const excluded = page.getByRole("region", { name: "Who didn't fit, and why" });
  await expect(
    excluded.getByText(
      /Taylor set a contribution limit below the share price \(share would be at least \$15\.00\)/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Each person takes 6 rolls for \$15\.00 instead of \$22\.00/),
  ).toBeVisible();

  await page.getByRole("link", { name: "Review and confirm" }).click();
  await expect(page.getByText("Waiting for everyone to confirm").first()).toBeVisible();

  // Keyboard confirmation through the accessible dialog.
  await page.getByRole("button", { name: "Review and confirm my terms" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm your terms" });
  await expect(dialog.getByText("$7.00")).toBeVisible();
  // Keep the manual contribution path covered here; auto-pay has its own journey.
  await dialog.getByLabel(/Pay automatically/).uncheck();
  await dialog.getByRole("button", { name: "Confirm my share" }).click();
  await expect(dialog).toBeHidden();

  for (const persona of ["Jordan", "Sam", "Riley"]) await operator(page, "Confirm", persona);
  await closeOperator(page);
  await expect(page.getByText("Collecting contributions").first()).toBeVisible();

  const contribute = page.getByRole("button", { name: "Contribute $15.00" });
  await contribute.dblclick();
  await expect(page.getByText("$15.00 confirmed of $60.00")).toBeVisible();
  await operator(page, "Contribute", "Jordan");
  await closeOperator(page);
  await expect(page.getByText("$30.00 confirmed of $60.00")).toBeVisible();

  await operator(page, "Leave", "Jordan");
  await closeOperator(page);
  await expect(page.getByText("Looking for a replacement").first()).toBeVisible();
  await expect(page.getByText("$15.00 confirmed of $60.00")).toBeVisible();
  await expect(page.getByText("Return confirmed")).toBeVisible();

  // Auto-replacement offers Jordan's exact share to Casey without anyone clicking.
  await expect(page.getByRole("rowheader", { name: /Casey/ })).toBeVisible();
  await operator(page, "Confirm", "Casey");
  for (const persona of ["Casey", "Sam", "Riley"]) await operator(page, "Contribute", persona);
  await closeOperator(page);
  await expect(page.getByText("$60.00 confirmed of $60.00")).toBeVisible();
  await expect(page.getByText("Ready to purchase").first()).toBeVisible();

  await page.getByRole("button", { name: "Record purchase ($60.00)" }).click();
  await expect(page.getByText("Purchased — ready for pickup").first()).toBeVisible();

  await page.getByRole("button", { name: "I picked up my 6 rolls" }).click();
  for (const persona of ["Sam", "Riley", "Casey"]) await operator(page, "Pick up", persona);
  await closeOperator(page);
  await expect(page.getByText("Complete").first()).toBeVisible();
  await expect(page.getByText(/Merchant purchase · \$60\.00/)).toBeVisible();
});

test("persona switching and reset keep sessions isolated", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start the demo \(rehearsal\)/ }).click();
  await expect(page.getByText("Hi Alex")).toBeVisible();

  await page.getByLabel("Choose demo shopper").selectOption({ label: "Taylor" });
  await expect(page.getByText("Hi Taylor")).toBeVisible();
  await expect(page.getByText("Looking for a group")).toBeVisible();

  await page.getByRole("button", { name: "Demo controls" }).click();
  await page.getByRole("button", { name: "Reset demo (new session)" }).click();
  await expect(page.getByText("Hi Alex")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your groups" })).toHaveCount(0);
});

test("start a group, fill it by invite and let auto-pay and auto-purchase finish", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start the demo \(rehearsal\)/ }).click();
  await expect(page.getByText("Hi Alex")).toBeVisible();

  await page.getByText("Start my own group").click();
  await page.getByLabel("Invite only (share a link)").check();
  await expect(page.getByLabel(/Pay my share automatically/)).toBeChecked();
  await expect(page.getByLabel(/Record the purchase automatically/)).toBeChecked();
  await page.getByRole("button", { name: "Start my group" }).click();

  await expect(page.getByText("Open — looking for members").first()).toBeVisible();
  await expect(page.getByText("6 of 24 rolls")).toBeVisible();
  const inviteText = await page.locator("code").first().textContent();
  const invitePath = new URL(inviteText ?? "").pathname;
  expect(invitePath).toMatch(/^\/join\/[A-Z2-9]{8}$/);

  // Jordan follows the invite link and joins with auto-pay.
  await page.getByLabel("Choose demo shopper").selectOption({ label: "Jordan" });
  await expect(page.getByLabel("Choose demo shopper")).toHaveValue(/.+/);
  await page.goto(invitePath);
  await expect(page.getByRole("heading", { name: "Join this group" })).toBeVisible();
  await page.getByLabel(/How many rolls\?/).fill("6");
  await page.getByRole("button", { name: "Join for $15.00" }).click();
  await expect(page.getByText("12 of 24 rolls")).toBeVisible();

  // Sam and Riley join from the operator panel; the package fills, everyone auto-pays and
  // the organizer's pre-authorized purchase is recorded.
  await operator(page, "Join", "Sam");
  await operator(page, "Join", "Riley");
  await closeOperator(page);
  await expect(page.getByText("Purchased — ready for pickup").first()).toBeVisible();
  await expect(page.getByText(/Merchant purchase · \$60\.00/)).toBeVisible();

  await page.getByRole("button", { name: /Notifications/ }).click();
  await expect(page.getByText("Your $15.00 contribution is confirmed.")).toBeVisible();
  await expect(page.getByText(/purchase is recorded/)).toBeVisible();
});

test("plain-English request, estimated savings, wallet and insights", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start the demo \(rehearsal\)/ }).click();
  await expect(page.getByText("Hi Alex")).toBeVisible();

  await page.getByLabel("Describe what you need").fill("about 5 rolls of paper towels, under $20");
  await page.getByRole("button", { name: "Fill the form" }).click();
  await expect(
    page.getByText(/Filled \d fields? from your words \(read by the rehearsal parser/),
  ).toBeVisible();
  await expect(page.getByLabel("How many rolls?")).toHaveValue("5");
  await expect(page.getByText("$18.50")).toBeVisible();
  await expect(page.getByText("estimated", { exact: true })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Wallet" })
    .click();
  await expect(page.getByRole("heading", { name: "Alex's account" })).toBeVisible();
  await expect(page.getByText("Spectrum Internet")).toBeVisible();
  await expect(page.getByText("Safe to contribute to groups")).toBeVisible();
  await expect(page.getByText("$25.00", { exact: true })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Insights" })
    .click();
  await expect(page.getByRole("heading", { name: "How buying together is going" })).toBeVisible();
  await expect(page.getByText(/Local rehearsal queries/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Open demand by product and pickup" }),
  ).toBeVisible();
});
