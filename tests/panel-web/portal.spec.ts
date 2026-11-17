import { expect, test, type Page } from "@playwright/test";

// The portal on its dev stub (VITE_STUB=1): fixtures from
// src/web/portal/dev/fixtures.ts, signed in as jane.doe@example.com with two
// linked chat identities (both on Slack) and three integrations.

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

async function settled(page: Page, ready: string) {
  await expect(page.getByRole("main").getByText(ready).first()).toBeVisible();
  await expect(page.locator(".sl-skeleton, tr.is-skeleton")).toHaveCount(0);
}

const PAGES = [
  { path: "/portal/", heading: "My account", ready: "TSANDBOX" },
  { path: "/portal/integrations", heading: "Integrations", ready: "docs-wiki" },
  { path: "/portal/agents", heading: "My agents", ready: "triage" },
];

test("the account page lists the linked identities", async ({ page }) => {
  await page.goto("/portal/");
  await expect(h1(page)).toHaveText("My account");
  await expect(page.getByRole("heading", { name: "Linked chat identities" })).toBeVisible();
  await settled(page, "TSANDBOX");
  await expect(page.getByRole("main")).toContainText("jane.doe@example.com");
  await expect(page.getByRole("button", { name: "Unlink Alice in Example Workspace (Slack)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlink UJANEDOE in TSANDBOX (Slack)" })).toBeVisible();
});

test("unlinking an identity asks first, then confirms with a toast", async ({ page }) => {
  await page.goto("/portal/");
  await page.getByRole("button", { name: "Unlink UJANEDOE in TSANDBOX (Slack)" }).click();
  const dialog = page.getByRole("dialog", { name: "Unlink this chat identity?" });
  await expect(dialog).toContainText("UJANEDOE in TSANDBOX (Slack) stops resolving to your account.");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Unlink UJANEDOE in TSANDBOX (Slack)" })).toBeVisible();

  await page.getByRole("button", { name: "Unlink UJANEDOE in TSANDBOX (Slack)" }).click();
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(toasts(page).getByText("Chat identity unlinked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlink UJANEDOE in TSANDBOX (Slack)" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlink Alice in Example Workspace (Slack)" })).toBeVisible();
});

test("a successful connect returns to integrations with a toast", async ({ page }) => {
  await page.goto("/portal/integrations");
  await page.getByRole("button", { name: "Connect docs-wiki" }).click();
  await expect(toasts(page).getByText("Integration connected")).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/integrations$/);
  await expect(page.getByRole("button", { name: "Disconnect docs-wiki" })).toBeVisible();
});

test("a failed connect shows what went wrong and leaves it disconnected", async ({ page }) => {
  await page.goto("/portal/integrations?stubConnect=exchange-failed");
  await page.getByRole("button", { name: "Connect docs-wiki" }).click();
  await expect(toasts(page).getByText("The service refused the connection")).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/integrations$/);
  await expect(page.getByRole("button", { name: "Connect docs-wiki" })).toBeVisible();
});

test("the connect return reads ?connect= once, including unknown results", async ({ page }) => {
  await page.goto("/portal/?connect=connected");
  await expect(toasts(page).getByText("Integration connected")).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/integrations$/);

  await page.goto("/portal/?connect=state-mismatch");
  await expect(toasts(page).getByText("Connection refused")).toBeVisible();

  await page.goto("/portal/?connect=something-else");
  await expect(toasts(page).getByText("Connection did not complete")).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/integrations$/);
});

test("disconnecting asks first, then confirms with a toast", async ({ page }) => {
  await page.goto("/portal/integrations");
  await page.getByRole("button", { name: "Disconnect issue-tracker" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect issue-tracker?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(toasts(page).getByText("issue-tracker disconnected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect issue-tracker" })).toBeVisible();
});

test("my agents lists each agent with my role", async ({ page }) => {
  await page.goto("/portal/agents");
  await expect(h1(page)).toHaveText("My agents");
  await settled(page, "triage");
  const table = page.getByRole("table");
  await expect(table.getByRole("row").filter({ hasText: "default" })).toContainText("Manager");
  await expect(table.getByRole("row").filter({ hasText: "triage" })).toContainText("Member");
});

test("an empty account shows empty states", async ({ page }) => {
  await page.goto("/portal/?stubEmpty=1");
  await expect(page.getByText("No chat identity linked yet")).toBeVisible();
  await page.goto("/portal/integrations");
  await expect(page.getByText("No integrations to connect")).toBeVisible();
  await page.goto("/portal/agents");
  // No chat identity linked: say so and how to link, not "ask a manager".
  await expect(page.getByText("No chat identity linked", { exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Send /link to the agent as a message (in Slack, put a space before it or mention the agent");
  await expect(page.getByText("Ask an agent's manager")).toHaveCount(0);
});

test("linked identities with no grants keep the ask-a-manager empty state", async ({ page }) => {
  await page.goto("/portal/agents?stubNoAgents=1");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await expect(page.getByText("Ask an agent's manager to grant you access.")).toBeVisible();
});

test("a failed load offers Try again", async ({ page }) => {
  await page.goto("/portal/integrations?stubFail=integrations");
  await expect(h1(page)).toHaveText("Integrations");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test.describe("at 390 px wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const p of PAGES) {
    test(`${p.path} has no horizontal page scroll`, async ({ page }) => {
      await page.goto(p.path);
      await expect(h1(page)).toHaveText(p.heading);
      await settled(page, p.ready);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});

test("identities and agents show workspace and user names, ids as secondary text", async ({ page }) => {
  await page.goto("/portal/");
  await settled(page, "TSANDBOX");
  const row = page.getByRole("row").filter({ hasText: "Example Workspace" });
  await expect(row).toContainText("TWORKSPACE");
  await expect(row).toContainText("Alice");
  await expect(row).toContainText("UALICE");
  // No name resolved: the id alone.
  await expect(page.getByRole("row").filter({ hasText: "TSANDBOX" })).toContainText("UJANEDOE");
  await page.goto("/portal/agents");
  await expect(page.getByRole("row").filter({ hasText: "triage" })).toContainText("Example Workspace");
});

test("the account and agents tables name the surface, not Slack in their headings", async ({ page }) => {
  await page.goto("/portal/");
  await settled(page, "TSANDBOX");
  const ids = page.getByRole("table", { name: "Linked chat identities" });
  const headers = await ids.getByRole("columnheader").allTextContents();
  expect(headers.slice(0, 3)).toEqual(["Surface", "Workspace", "User"]);
  await expect(ids.getByRole("row").filter({ hasText: "Example Workspace" }).getByRole("cell").first()).toHaveText("Slack");
  await expect(page.getByRole("main")).not.toContainText("Slack user");
  await expect(page.getByRole("main")).not.toContainText("Slack identit");
  await page.goto("/portal/agents");
  await settled(page, "triage");
  const agents = await page.getByRole("table", { name: "My agents" }).getByRole("columnheader").allTextContents();
  expect(agents.slice(0, 4)).toEqual(["Agent", "Surface", "Workspace", "As user"]);
  await expect(page.getByRole("main")).not.toContainText("Slack user");
});
