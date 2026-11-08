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
  { path: "/panel/skills", heading: "Skills", ready: "release-notes" },
  { path: "/panel/skills/base%3Arelease-notes", heading: /release-notes/, ready: "Pinned commit", sub: "SKILL.md" },
  { path: "/panel/skills/retired%3Adefault%3Astandup-notes-20261020T090000Z", heading: /standup-notes/, ready: "Unused for 60 days.", sub: "Provenance" },
  { path: "/panel/guardrails", heading: "Guardrails", ready: "SLAUDE_AUTO_ALLOW_TOOLS", sub: "Tool permissions" },
  { path: "/panel/guardrails?agent=scout", heading: "Guardrails", ready: "UBOB", sub: "Approvals" },
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
  for (const name of ["Agents", "Sessions", "Approvals and audit", "Access", "Memory", "Environments", "Skills", "Guardrails", "Overview"]) {
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

  test("a DM id is not a channel: the form points to a DM-only user grant", async ({ page }) => {
    await page.goto("/panel/agents/scout/access");
    await page.getByRole("button", { name: "Add grant" }).click();
    const dialog = page.getByRole("dialog", { name: "Add grant" });
    await dialog.getByLabel("Subject kind").selectOption("channel");
    await dialog.getByLabel("Slack id").fill("DDIRECT");
    await dialog.getByRole("button", { name: "Add grant" }).click();
    await expect(dialog.getByText("That is a DM, not a channel.", { exact: false })).toBeVisible();
    await dialog.getByLabel("Slack id").fill("GPRIV");
    await dialog.getByRole("button", { name: "Add grant" }).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText("Grant added")).toBeVisible();
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

test("an agent actor reads as the agent's name, not its bot user id", async ({ page }) => {
  await page.goto("/panel/");
  const recent = page.getByRole("table", { name: "Recent activity" });
  const row = recent.getByRole("row").filter({ hasText: "retired skill standup-notes" });
  const actor = row.getByRole("cell").nth(2);
  await expect(actor).toContainText("scout");
  await expect(actor).toContainText("Agent");
  await expect(actor).not.toContainText("USCOUT");
  await expect(actor.getByText("scout", { exact: true })).toHaveAttribute("title", "USCOUT");
});

test("the markdown copy button says Copied, announces it, and goes back to its icon", async ({ page }) => {
  await page.goto("/panel/skills/base%3Arelease-notes");
  await page.evaluate(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void (window as unknown as { __copied: string[] }).__copied.push(t) },
    });
  });
  const button = page.getByRole("button", { name: "Copy SKILL.md" });
  await button.click();
  const done = page.getByRole("button", { name: "Copied" });
  await expect(done).toBeVisible();
  await expect(done).toContainText("Copied");
  await expect(done).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toHaveAttribute("aria-live", "polite");
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain("name: release-notes");
  // About two seconds later it is the icon again.
  await expect(page.getByRole("button", { name: "Copy SKILL.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy SKILL.md" })).not.toContainText("Copied");
});

test("a refused clipboard shows Copy failed", async ({ page }) => {
  await page.goto("/panel/skills/base%3Arelease-notes");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } },
    });
  });
  await page.getByRole("button", { name: "Copy SKILL.md" }).click();
  const failed = page.getByRole("button", { name: "Copy failed" });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("Copy failed");
  await expect(page.getByRole("status").filter({ hasText: "Copy failed" })).toBeAttached();
});

test("an empty deployment shows empty states", async ({ page }) => {
  await page.goto("/panel/agents?stubEmpty=1");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await page.goto("/panel/?stubEmpty=1");
  await expect(page.getByText("No activity yet")).toBeVisible();
});

test.describe("session watch", () => {

  test("the timeline shows earlier turns, the Slack message, the reply as the agent's message, and results paired by id", async ({ page }) => {
    await page.goto("/panel/sessions/s_7f21");
    const tl = page.locator(".sl-tl__scroll");
    // Earlier turns from the conversation record, above the live tail.
    await expect(tl.getByRole("separator").filter({ hasText: "Earlier in this session" })).toBeVisible();
    await expect(tl.getByText("Last earlier answer: the checklist lives in docs/release-checklist.md.")).toBeVisible();
    await expect(tl.getByText("Earliest question: where is the release checklist?")).toHaveCount(0);
    await tl.getByRole("button", { name: "Load earlier" }).click();
    await expect(tl.getByText("Earliest question: where is the release checklist?")).toBeVisible();
    await expect(tl.getByRole("button", { name: "Load earlier" })).toHaveCount(0);

    // The inbound Slack message on the live tail.
    await expect(tl.getByText("Can you check the release checklist against the branch?")).toBeVisible();
    // The reply tool's text is the agent's message, marked as sent; no raw reply tool row.
    const reply = tl.locator(".sl-tl__msg").filter({ hasText: "Want me to draft the release notes next?" });
    await expect(reply).toBeVisible();
    await expect(reply.getByText("Sent to Slack")).toBeVisible();
    await expect(tl.locator(".sl-tl__tool-name").filter({ hasText: "mcp__slaude_surface__reply" })).toHaveCount(0);

    // Two parallel reads, results back in the other order: each sits under its own call.
    const changelog = tl.locator(".sl-tl__tool").filter({ hasText: "CHANGELOG.md" });
    await changelog.locator("summary").click();
    await expect(changelog.getByText("Console session history", { exact: false })).toBeVisible();
    await expect(changelog.getByText("Tests pass on the release branch", { exact: false })).toHaveCount(0);
    const checklist = tl.locator(".sl-tl__tool").filter({ hasText: "docs/release-checklist.md" });
    await checklist.locator("summary").click();
    await expect(checklist.getByText("Tests pass on the release branch", { exact: false })).toBeVisible();
  });

  test("status reads Working during a turn, then Warm; a stored running row nothing holds is Idle", async ({ page }) => {
    await page.goto("/panel/sessions/s_7f21?stubDelay=0");
    await expect(h1(page).getByText("Working")).toBeVisible();
    await expect(h1(page).getByText("Warm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Context 35% used \(70,200 tokens\)/)).toBeVisible();

    await page.goto("/panel/sessions");
    await settled(page, "Compare queue libraries");
    const stale = page.getByRole("row").filter({ hasText: "DM with alice" });
    await expect(stale.getByText("Idle")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Compare queue libraries" }).getByText("Warm")).toBeVisible();
    await page.goto("/panel/");
    await expect(page.getByRole("link", { name: /^Active sessions 2/ })).toBeVisible();
  });

  test("chat: the agent's reply to the operator is held in the console while they drive", async ({ page }) => {
    await page.goto("/panel/sessions/s_5c11/chat");
    const log = page.getByRole("log").or(page.getByLabel("Conversation")).first();
    await expect(log.getByText("Earlier answer 2")).toBeVisible();
    await page.getByRole("button", { name: "Take control" }).click();
    await page.getByLabel("Message").fill("summarise the open items");
    await page.getByRole("button", { name: "Send" }).click();
    const reply = log.locator(".sl-chat__msg").filter({ hasText: "Got it. Working on: summarise the open items" });
    await expect(reply).toBeVisible();
    await expect(reply.getByText("Held in console")).toBeVisible();
    await expect(log.getByRole("separator").filter({ hasText: "Earlier in this session" })).toBeVisible();
  });

  test("Slack markup in messages reads as Slack shows it; a date-only line shows no clock", async ({ page }) => {
    await page.goto("/panel/sessions/s_7f21");
    const tl = page.locator(".sl-tl__scroll");
    const line = tl.locator(".sl-tl__msg").filter({ hasText: "read the runbook first" });
    await expect(line).toBeVisible();
    await expect(line.getByRole("link", { name: "the runbook" })).toHaveAttribute("href", "https://example.com/runbook");
    await expect(line.getByText("@bob", { exact: true })).toBeVisible();
    await expect(line.getByText("#ops", { exact: true })).toBeVisible();
    await expect(line).toContainText("Ask @bob in #ops & read the runbook first");
    await expect(tl.getByText("<@UBOB>", { exact: false })).toHaveCount(0);
    await expect(tl.getByText("&amp;", { exact: false })).toHaveCount(0);

    await tl.getByRole("button", { name: "Load earlier" }).click();
    const cron = tl.locator(".sl-tl__msg").filter({ hasText: /Earlier question 2$/ });
    await expect(cron.locator("time")).toHaveAttribute("title", "Only the day of this line is recorded");
  });

  test("with memory off the timeline says why there is no history", async ({ page }) => {
    await page.goto("/panel/sessions/s_6a02?stubNoHistory=1");
    await expect(page.getByText("No earlier turns to show: memory is disabled", { exact: false })).toBeVisible();
  });
});

test.describe("console polish", () => {
  test("sessions load 50 at a time; Load more appends the rest; every row says its model and channel", async ({ page }) => {
    await page.goto("/panel/sessions?stubDelay=0");
    await settled(page, "Compare queue libraries");
    const table = page.getByRole("table", { name: "Sessions" });
    const body = table.locator("tbody tr");
    await expect(body).toHaveCount(50);
    await expect(page.getByText("50 loaded, newest first")).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(body).toHaveCount(63);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    await expect(table.getByRole("row").filter({ hasText: "Older thread 54" })).toBeVisible();
    // Model: the row's own, the agent's configured one, or the deployment default (muted).
    await expect(table.getByRole("row").filter({ hasText: "Release checklist for the console" })).toContainText("claude-sonnet-4-5");
    const leftover = table.getByRole("row").filter({ hasText: "Notes from a channel the app left" });
    await expect(leftover).toContainText("claude-sonnet-4-5");
    // A channel the gateway could not name keeps its id.
    await expect(leftover).toContainText("CGONE");
    await expect(table.getByRole("row").filter({ hasText: "Older thread 1" }).first().getByText("Deployment default")).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: "Compare queue libraries" })).toContainText("#team");
  });

  test("the session header names the channel", async ({ page }) => {
    await page.goto("/panel/sessions/s_6a02");
    await expect(page.locator(".sl-session-meta")).toContainText("#ops, thread");
  });

  test("mandates show #channel names, never Slack tokens; a filesystem persona lists its heartbeat and cron", async ({ page }) => {
    await page.goto("/panel/agents/default/mandates");
    await expect(page.getByRole("heading", { name: "Mandate in #team" })).toBeVisible();
    await expect(page.getByText("<#", { exact: false })).toHaveCount(0);
    await page.goto("/panel/agents/triage/mandates");
    await expect(page.getByRole("heading", { name: "Heartbeat" }).first()).toBeVisible();
    await expect(page.getByText("Sweep unacknowledged alerts").first()).toBeVisible();
  });

  test("audit: console-wide rows have no agent; an operator's role is named", async ({ page }) => {
    await page.goto("/panel/audit");
    await settled(page, "Bash: run the test suite");
    const reload = page.getByRole("row").filter({ hasText: "Agent config reloaded" });
    await expect(reload).toContainText("Console");
    await expect(reload).toContainText("Superadmin");
    const signIn = page.getByRole("row").filter({ hasText: "Signed in to console" });
    // An older row written under the default agent still reads as Console.
    await expect(signIn).toContainText("Console");
    await expect(signIn).not.toContainText("default");
    const grant = page.getByRole("row").filter({ hasText: "approver for user UALICE" });
    await expect(grant).toContainText("Superadmin");
  });
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

test.describe("resources", () => {
  test("the sidebar groups Skills and Guardrails under Resources", async ({ page }) => {
    await page.goto("/panel/");
    const nav = page.getByRole("navigation", { name: "Console navigation" });
    await expect(nav.getByText("Resources", { exact: true })).toBeVisible();
    const items = await nav.locator("li").allInnerTexts();
    const at = items.indexOf("Resources");
    expect(items.slice(at, at + 3)).toEqual(["Resources", "Skills", "Guardrails"]);
  });

  test("skills filter by source, agent and status, and search", async ({ page }) => {
    await page.goto("/panel/skills");
    await settled(page, "release-notes");
    const table = page.getByRole("table", { name: "Skills" });
    await page.getByRole("button", { name: /^Source: / }).click();
    await page.getByRole("menuitemradio", { name: "Plugin" }).click();
    await expect(table.getByRole("row").filter({ hasText: "search-docs" })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "release-notes" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Source: / }).click();
    await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: /^Status: / }).click();
    await page.getByRole("menuitemradio", { name: "Retired" }).click();
    await expect(table.getByRole("row").filter({ hasText: "standup-notes" })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "release-notes" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Status: / }).click();
    await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: /^Agent: / }).click();
    await page.getByRole("menuitemradio", { name: "scout" }).click();
    await expect(table.getByRole("row").filter({ hasText: "weekly-digest" })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: "release-notes" })).toHaveCount(0);
    await page.getByLabel("Search skills").fill("summarise");
    await expect(table.getByRole("row").filter({ hasText: "weekly-digest" })).toHaveCount(1);
    await page.getByLabel("Search skills").fill("nothing like this");
    await expect(page.getByText("No matching skills")).toBeVisible();
  });

  test("a skill's SKILL.md renders as markdown, with frontmatter, and switches to raw (remembered)", async ({ page }) => {
    await page.goto("/panel/skills/base%3Arelease-notes");
    const md = page.locator(".sl-markdown").first();
    // Frontmatter as key and value, body rendered: heading, table, task list, code, a safe link.
    await expect(md.locator(".sl-md__frontmatter")).toContainText("Draft release notes from merged pull requests.");
    await expect(md.getByRole("heading", { name: "Release notes" })).toBeVisible();
    await expect(md.getByRole("table")).toContainText("Features");
    await expect(md.getByRole("checkbox", { name: "Done", exact: true })).toBeChecked();
    await expect(md.locator(".sl-code")).toContainText("git log --oneline v1.0.0..HEAD");
    const link = md.getByRole("link", { name: "the style guide" });
    await expect(link).toHaveAttribute("href", "https://example.com/style");
    await expect(link).toHaveAttribute("title", "https://example.com/style");
    await expect(link).toHaveAttribute("rel", /noopener/);
    // Raw shows the text as written, and the choice survives a reload.
    await md.getByRole("button", { name: "Raw" }).click();
    await expect(md.locator(".sl-md-raw")).toContainText("| Section | Required |");
    await page.reload();
    await expect(page.locator(".sl-markdown").first().locator(".sl-md-raw")).toContainText("- [x] Link each pull request once");
    await page.locator(".sl-markdown").first().getByRole("button", { name: "Rendered" }).click();
    await expect(page.locator(".sl-markdown").first().getByRole("heading", { name: "Release notes" })).toBeVisible();
  });

  test("a superadmin retires an agent-authored skill and restores it", async ({ page }) => {
    await page.goto("/panel/skills/agent%3Ascout%3Aweekly-digest");
    await page.getByRole("button", { name: "Retire skill" }).click();
    const dialog = page.getByRole("dialog", { name: "Retire this skill?" });
    await dialog.getByLabel("Reason").fill("replaced by release-notes");
    await dialog.getByRole("button", { name: "Retire" }).click();
    await expect(toasts(page).getByText("Skill retired")).toBeVisible();
    await expect(page).toHaveURL(/\/skills\/retired%3Ascout%3Aweekly-digest-/);
    await expect(h1(page)).toContainText("Retired");
    await page.getByRole("button", { name: "Restore skill" }).click();
    await page.getByRole("dialog", { name: "Restore this skill?" }).getByRole("button", { name: "Restore" }).click();
    await expect(toasts(page).getByText("Skill restored")).toBeVisible();
    await expect(page).toHaveURL(/\/skills\/agent%3Ascout%3Aweekly-digest$/);
  });

  test("an operator cannot retire a skill", async ({ page }) => {
    await page.goto("/panel/skills/agent%3Ascout%3Aweekly-digest?as=operator");
    await expect(page.getByText("Only a superadmin can retire or restore a skill.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retire skill" })).toBeDisabled();
  });

  test("guardrails show each value's source and the soul's own text, per agent", async ({ page }) => {
    await page.goto("/panel/guardrails");
    const tools = page.locator("#guardrail-tool-permissions");
    await expect(tools.getByText("Env", { exact: true })).toBeVisible();
    await expect(page.locator("#guardrail-policy").getByText("Not implemented")).toBeVisible();
    const proactive = page.locator("#guardrail-proactive");
    await expect(proactive.getByText("22:00 to 07:00")).toBeVisible();
    await expect(proactive.getByRole("heading", { name: "Proactive", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Agent: / }).click();
    await page.getByRole("menuitemradio", { name: "scout" }).click();
    await expect(page).toHaveURL(/\/guardrails\?agent=scout$/);
    await expect(page.locator("#guardrail-approvals").getByText("UBOB")).toBeVisible();
    await expect(page.locator("#guardrail-admission").getByRole("link", { name: "Grants on the Access tab" })).toHaveAttribute("href", "/panel/agents/scout/access");
  });

  test("guardrails show the runtime layer above the soul and access settings", async ({ page }) => {
    await page.goto("/panel/guardrails");
    const prompt = page.locator("#guardrails-system-prompt");
    const layers = prompt.getByRole("list", { name: "System prompt layers" });
    await expect(layers.getByRole("listitem")).toHaveCount(7);
    await expect(layers.locator('[data-layer="runtime-baseline"]').getByText("Fixed by the runtime")).toBeVisible();
    await expect(layers.locator('[data-layer="persona"]').getByText("From the soul")).toBeVisible();
    await expect(layers.locator('[data-layer="channel-mandate"]').getByText("2 channels")).toBeVisible();
    await expect(layers.locator('[data-layer="persona"]').getByRole("link", { name: "Mandates tab" })).toHaveAttribute("href", "/panel/agents/default/mandates");
    await expect(prompt.getByText("nothing in the code stops a soul from contradicting it")).toBeVisible();
    await expect(prompt.getByText(/one render for every agent of this deployment/)).toBeVisible();
    // A baseline block is folded until opened, then rendered with the shared markdown view.
    const block = page.locator("#baseline-channel-trust");
    await expect(block.locator(".sl-markdown")).toHaveCount(0);
    await block.locator("summary").click();
    await expect(block.locator(".sl-markdown").getByText("internal team channel.")).toBeVisible();
    await block.getByRole("button", { name: "Raw" }).click();
    await expect(block.locator(".sl-md-raw")).toContainText("## Channel trust");
    await block.getByRole("button", { name: "Rendered" }).click();
    await expect(block.getByRole("button", { name: "Copy block" })).toBeVisible();
    await expect(prompt.getByText("mcp__slaude_skills__write_skill")).toBeVisible();

    const hooks = page.getByRole("table", { name: "Hooks and gates" });
    await expect(hooks.getByRole("row").filter({ hasText: "Must reply or pass" })).toContainText("Enforcing");
    await expect(hooks.getByRole("row").filter({ hasText: "Remote mode local-tool deny" })).toContainText("SLAUDE_REMOTE");
    await expect(hooks.getByRole("row").filter({ hasText: "Decision gate" })).toContainText("Shadow");
    const kbFirst = hooks.getByRole("row").filter({ hasText: "KB-first Stop guard" });
    await expect(kbFirst).toContainText("Not built");
    await expect(kbFirst.getByRole("link", { name: /Design: KB-first enforcement/ })).toHaveAttribute("href", /2026-06-13-kb-first-enforcement/);
    // Observability hooks are behind the kind filter.
    await expect(hooks.getByText("Skill usage counter")).toHaveCount(0);
    await page.getByRole("button", { name: /^Kind: / }).click();
    await page.getByRole("menuitemradio", { name: "Observability" }).click();
    await expect(page).toHaveURL(/kind=observability/);
    await expect(hooks.getByText("Skill usage counter")).toBeVisible();
    await expect(hooks.getByText("Must reply or pass")).toHaveCount(0);

    const limits = page.locator("#guardrails-limits");
    await expect(limits.getByText("CLI scheduler tools")).toBeVisible();
    await expect(limits.getByText("ScheduleWakeup")).toBeVisible();
    await expect(limits.locator('[id="guardrail-redact.soul-patterns"]').getByText("project-[a-z]+")).toBeVisible();

    // The new sections come first, the old cards after them.
    const order = await page.locator("#guardrails-system-prompt, #guardrails-hooks, #guardrails-limits, #guardrail-tool-permissions").evaluateAll((els) => els.map((e) => e.id));
    expect(order).toEqual(["guardrails-system-prompt", "guardrails-hooks", "guardrails-limits", "guardrail-tool-permissions"]);
  });

  test("an operator sees how many redaction patterns, never the patterns", async ({ page }) => {
    await page.goto("/panel/guardrails?as=operator");
    const soul = page.locator('[id="guardrail-redact.soul-patterns"]');
    await expect(soul.getByText("1 pattern")).toBeVisible();
    await expect(page.getByText("project-[a-z]+")).toHaveCount(0);
  });

  test("agent messages render as markdown in the timeline and chat; user messages stay Slack text", async ({ page }) => {
    await page.goto("/panel/sessions/s_7f21");
    const tl = page.locator(".sl-tl__scroll");
    const msg = tl.locator(".sl-tl__msg").filter({ hasText: "release plan" });
    await expect(msg.locator("strong").filter({ hasText: "release plan" })).toBeVisible();
    await expect(msg.getByRole("link", { name: "the runbook" })).toHaveAttribute("href", "https://example.com/runbook");
    await expect(tl.locator(".sl-tl__msg.is-user").first().locator(".sl-md")).toHaveCount(0);
    await expect(tl.locator(".sl-tl__msg.is-user").first().getByText("in Slack")).toBeVisible();
    await page.goto("/panel/sessions/s_7f21/chat");
    await expect(page.locator(".sl-chat__msg").filter({ hasText: "release plan" }).locator("code").filter({ hasText: "v0.41.0" })).toBeVisible();
  });

  test("a memory page renders its markdown", async ({ page }) => {
    await page.goto("/panel/memory/shared/page?slug=runbooks%2Fdeploy-rollback");
    const content = page.locator(".sl-markdown").first();
    await expect(content.getByRole("heading", { name: "Steps" })).toBeVisible();
    await expect(content.locator("ol li").first()).toBeVisible();
  });
});

test("grant subjects show their names, ids as secondary text", async ({ page }) => {
  await page.goto("/panel/agents/scout/access");
  const table = page.getByRole("table", { name: "Grants on scout" });
  await expect(table.getByRole("row").filter({ hasText: "#team" }).first()).toContainText("CTEAM");
});
