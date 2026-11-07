import { expect, test, type Page } from "@playwright/test";

// The operator console on its dev stub (VITE_STUB=1): fixtures from
// src/web/console/dev/fixtures.ts, signed in as a superadmin unless ?as=operator.

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

/** Wait until the page shows its data: a marker text that only loaded data has, and no skeletons. */
async function settled(page: Page, ready?: string) {
  if (ready) await expect(page.getByRole("main").getByText(ready, { exact: false }).first()).toBeVisible();
  await expect(page.locator(".sl-skeleton, tr.is-skeleton")).toHaveCount(0);
}

/** Every page, with the heading it shows and a text that appears once its data loaded. */
const PAGES: Array<{ path: string; heading: string | RegExp; ready: string; sub?: string }> = [
  { path: "/panel/", heading: "Overview", ready: "Bash: run the test suite" },
  { path: "/panel/agents", heading: "Agents", ready: "triage" },
  { path: "/panel/agents/scout", heading: /scout/, ready: "USCOUT", sub: "Identity" },
  { path: "/panel/agents/scout/mandates", heading: /scout/, ready: "Research questions the team brings", sub: "Global" },
  { path: "/panel/agents/scout/access", heading: /scout/, ready: "Covering approvals this week", sub: "Effective grants" },
  { path: "/panel/agents/scout/activity", heading: /scout/, ready: "UBOB is not an approver here" },
  { path: "/panel/sessions", heading: "Sessions", ready: "Compare queue libraries" },
  { path: "/panel/sessions/s_7f21", heading: /Release checklist for the console/, ready: "Allowed Bash: run the test suite" },
  { path: "/panel/sessions/s_7f21/chat", heading: /Release checklist for the console/, ready: "Running the panel tests first" },
  { path: "/panel/sessions/s_7f21/audit", heading: /Release checklist for the console/, ready: "Denied: restart the staging deploy" },
  { path: "/panel/audit", heading: "Approvals and audit", ready: "Bash: run the test suite" },
  { path: "/panel/access", heading: "Access", ready: "bob@example.com", sub: "Console roles" },
  { path: "/panel/memory", heading: "Memory", ready: "kb-handbook" },
  { path: "/panel/memory/shared", heading: /Shared/, ready: "decisions/queue-library" },
  { path: "/panel/memory/shared/page?slug=runbooks%2Fdeploy-rollback", heading: "Rolling back a deploy", ready: "Announce the rollback", sub: "Content" },
  { path: "/panel/environments", heading: "Environments", ready: "node-g1", sub: "Node pools" },
];

test("the shell loads with the signed-in superadmin", async ({ page }) => {
  await page.goto("/panel/");
  await expect(h1(page)).toHaveText("Overview");
  await expect(page.getByRole("navigation", { name: "Console navigation" })).toBeVisible();
  await page.getByRole("button", { name: /^Account: / }).click();
  await expect(page.getByRole("menu", { name: "Account" })).toContainText("Superadmin");
});

test("the sidebar reaches every top-level page", async ({ page }) => {
  await page.goto("/panel/");
  const nav = page.getByRole("navigation", { name: "Console navigation" });
  for (const name of ["Agents", "Sessions", "Approvals and audit", "Access", "Memory", "Environments", "Overview"]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(h1(page)).toHaveText(name);
  }
});

test("agent and session detail tabs switch the URL and the panel", async ({ page }) => {
  await page.goto("/panel/agents");
  await page.getByRole("cell", { name: /scout/ }).first().click();
  await expect(page).toHaveURL(/\/panel\/agents\/scout$/);
  await expect(h1(page)).toContainText("scout");
  for (const [tab, url] of [["Mandates", /\/mandates$/], ["Access", /\/access$/], ["Activity", /\/activity$/], ["Overview", /\/scout$/]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }

  await page.goto("/panel/sessions/s_7f21");
  await expect(h1(page)).toContainText("Release checklist for the console");
  for (const [tab, url] of [[/^Chat/, /\/chat$/], [/^Audit/, /\/audit$/], [/^Timeline/, /\/s_7f21$/]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page).toHaveURL(url);
  }
});

for (const p of PAGES) {
  test(`page ${p.path} shows its heading`, async ({ page }) => {
    await page.goto(p.path);
    if (typeof p.heading === "string") await expect(h1(page)).toHaveText(p.heading);
    else await expect(h1(page)).toContainText(p.heading);
    await settled(page, p.ready);
    if (p.sub) await expect(page.getByRole("heading", { level: 2 }).filter({ hasText: p.sub }).first()).toBeVisible();
  });
}

test.describe("agent access tab", () => {
  test("a superadmin adds a grant: inline validation, then a toast and the new row", async ({ page }) => {
    await page.goto("/panel/agents/scout/access");
    await page.getByRole("button", { name: "Add grant" }).click();
    const dialog = page.getByRole("dialog", { name: "Add grant" });
    await expect(dialog).toBeVisible();

    const id = dialog.getByLabel("Slack id");
    await id.fill("xyz");
    await dialog.getByRole("button", { name: "Add grant" }).click();
    await expect(dialog.getByText("A Slack user id starts with U or W, then uppercase letters and digits.", { exact: true })).toBeVisible();
    await expect(id).toBeFocused();
    await expect(id).toHaveAttribute("aria-invalid", "true");

    await id.fill("UNEWPERSON");
    await dialog.getByRole("button", { name: "Add grant" }).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText("Grant added")).toBeVisible();
    await expect(page.getByRole("table", { name: "Grants on scout" }).getByRole("row").filter({ hasText: "UNEWPERSON" })).toHaveCount(1);
  });

  test("an operator sees grants but cannot add or revoke", async ({ page }) => {
    await page.goto("/panel/agents/scout/access?as=operator");
    await expect(page.getByRole("heading", { name: "Effective grants" })).toBeVisible();
    await expect(page.getByText("You can view grants. Ask a superadmin to add or revoke one.")).toBeVisible();
    await settled(page, "Covering approvals this week");
    await expect(page.getByRole("button", { name: "Add grant" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  });
});

test.describe("console access page", () => {
  test("an operator sees a note instead of the console roles, never a refusal", async ({ page }) => {
    // The stub answers console-roles 403 to an operator (as the gateway does),
    // so a call would show the forbidden error state.
    await page.goto("/panel/access?as=operator");
    await expect(h1(page)).toHaveText("Access");
    await expect(page.getByText("Only superadmins can see who has console access.", { exact: false })).toBeVisible();
    await settled(page);
    await expect(page.getByRole("main").getByText("bob@example.com")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Agent grants" })).toBeVisible();
    await expect(page.getByText("Your console role cannot see this.")).toHaveCount(0);
  });
});

test.describe("approvals and audit", () => {
  test("filters write the URL and narrow the table", async ({ page }) => {
    await page.goto("/panel/audit");
    const rows = page.getByRole("table", { name: "Audit events" }).locator("tbody tr");
    await settled(page, "Bash: run the test suite");
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Decision: Any" }).click();
    await page.getByRole("menuitemradio", { name: "Deny" }).click();
    await expect(page).toHaveURL(/[?&]decision=deny(&|$)/);
    await expect(page.getByRole("button", { name: "Decision: Deny" })).toBeVisible();
    await settled(page);
    await expect(rows.filter({ hasText: "Bash: run the test suite" })).toHaveCount(0);
    await expect.poll(() => rows.count()).toBeLessThan(before);
    for (const r of await rows.all()) await expect(r).toContainText("Deny");

    await page.getByRole("button", { name: "Agent: All" }).click();
    await page.getByRole("menuitemradio", { name: "scout" }).click();
    await expect(page).toHaveURL(/persona=scout/);
    await expect(page).toHaveURL(/decision=deny/);

    await page.getByRole("button", { name: "Decision: Deny" }).click();
    await page.getByRole("menuitemradio", { name: "Any" }).click();
    await expect(page).not.toHaveURL(/decision=/);
  });

  test("a row opens the event drawer and Escape closes it", async ({ page }) => {
    await page.goto("/panel/audit");
    await settled(page, "Bash: run the test suite");
    await page.getByRole("table", { name: "Audit events" }).locator("tbody tr").first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});

test("the account menu switches the theme", async ({ page }) => {
  await page.goto("/panel/");
  const html = page.locator("html");
  for (const [item, value] of [["Dark theme", "dark"], ["Light theme", "light"]] as const) {
    await page.getByRole("button", { name: /^Account: / }).click();
    await page.getByRole("menuitemradio", { name: item }).click();
    await expect(html).toHaveAttribute("data-theme", value);
  }
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("menuitemradio", { name: "System theme" }).click();
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
});

test("a failed load offers Try again", async ({ page }) => {
  await page.goto("/panel/?stubFail=overview");
  await expect(h1(page)).toHaveText("Overview");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("an empty deployment shows empty states", async ({ page }) => {
  await page.goto("/panel/agents?stubEmpty=1");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await page.goto("/panel/?stubEmpty=1");
  await expect(page.getByText("No activity yet")).toBeVisible();
});

test.describe("at 390 px wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const p of PAGES) {
    test(`${p.path} has no horizontal page scroll`, async ({ page }) => {
      await page.goto(p.path);
      await expect(h1(page)).toBeVisible();
      await settled(page, p.ready);
      const fits = () => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth);
      expect(await fits()).toBe(true);
    });
  }
});
