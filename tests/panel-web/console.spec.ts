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
  { path: "/panel/users", heading: "Users", ready: "j***@example.com" },
  { path: "/panel/merges", heading: "Merges", ready: "2 bindings, 1 grants" },
  { path: "/panel/proposals", heading: "Proposals", ready: "j***@example.com" },
  { path: "/panel/boundaries", heading: "Boundaries", ready: "C1EXAMPLE" },
  { path: "/panel/memory", heading: "Memory", ready: "kb-handbook" },
  { path: "/panel/memory/shared", heading: /Shared/, ready: "decisions/queue-library" },
  { path: "/panel/memory/shared/page?slug=runbooks%2Fdeploy-rollback", heading: "Rolling back a deploy", ready: "Announce the rollback", sub: "Content" },
  { path: "/panel/environments", heading: "Environments", ready: "node-g1", sub: "Node pools" },
  { path: "/panel/skills", heading: "Skills", ready: "release-notes" },
  { path: "/panel/plugins", heading: "Plugins", ready: "example-toolkit" },
  { path: "/panel/skills/base%3Arelease-notes", heading: /release-notes/, ready: "Pinned commit", sub: "SKILL.md" },
  { path: "/panel/skills/retired%3Adefault%3Astandup-notes-20261020T090000Z", heading: /standup-notes/, ready: "Unused for 60 days.", sub: "Provenance" },
  { path: "/panel/guardrails", heading: "Guardrails", ready: "no-outbound-email" },
  { path: "/panel/guardrails/new", heading: "New guardrail", ready: "Checked by the server's parser", sub: "GUARDRAIL.md" },
  { path: "/panel/guardrails/no-outbound-email/edit", heading: "Edit no-outbound-email", ready: "Checked by the server's parser", sub: "GUARDRAIL.md" },
  { path: "/panel/guardrails/test", heading: "Test a guardrail", ready: "Run test", sub: "Event" },
  { path: "/panel/guardrails/no-outbound-email", heading: "no-outbound-email", ready: "Sending email is not allowed", sub: "Rules" },
  { path: "/panel/agents/scout/guardrails", heading: /scout/, ready: "no-outbound-email" },
];

test("the agent's Overview shows its definition as read-only YAML with a copy control", async ({ page }) => {
  await page.goto("/panel/agents/scout");
  const main = page.getByRole("main");
  await settled(page, "USCOUT");
  await expect(main.getByText("Definition", { exact: true })).toBeVisible();
  await expect(main.locator(".sl-definition code")).toContainText("name: scout");
  await expect(main.locator(".sl-definition code")).toContainText("userToken: <redacted>");
  await expect(main.locator(".sl-definition").getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(main.getByText("edit this agent's agent.yaml", { exact: false })).toBeVisible();
});

test("the Access tab keeps grants on top and the parsed settings folded", async ({ page }) => {
  await page.goto("/panel/agents/scout/access");
  await settled(page, "Covering approvals this week");
  const fold = page.locator("details.sl-fold");
  await expect(fold).toBeVisible();
  await expect(fold).not.toHaveAttribute("open", "");
  await fold.getByText("Approvals and permissions details").click();
  await expect(fold).toHaveAttribute("open", "");
});

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
  for (const name of ["Agents", "Sessions", "Approvals and audit", "Access", "Users", "Merges", "Proposals", "Boundaries", "Memory", "Environments", "Skills", "Guardrails", "Overview"]) {
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

  test("the Versions card lists a skill's history and shows one version's SKILL.md", async ({ page }) => {
    await page.goto("/panel/skills");
    await expect(page.getByRole("row").filter({ hasText: "release-notes" }).getByText("v2")).toBeVisible();
    await page.goto("/panel/skills/base%3Arelease-notes");
    const card = page.locator(".sl-card").filter({ has: page.getByText("Versions", { exact: true }) });
    await expect(card.getByRole("row").filter({ hasText: "v1" }).getByText("1b7e4c2f90a3")).toBeVisible();
    await card.getByRole("row").filter({ hasText: "v1" }).getByRole("button", { name: "View SKILL.md" }).click();
    await expect(card.getByText("List the merged pull requests.")).toBeVisible();
    await card.getByRole("row").filter({ hasText: "v1" }).getByRole("button", { name: "Hide" }).click();
    await expect(card.getByText("List the merged pull requests.")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Rollback" })).toHaveCount(0);
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

  test("an operator sees an agent skill's versions but not their text", async ({ page }) => {
    await page.goto("/panel/skills/agent%3Ascout%3Aweekly-digest?as=operator");
    const card = page.locator(".sl-card").filter({ has: page.getByText("Versions", { exact: true }) });
    await expect(card.getByText("7c3a9e5d1f0b")).toBeVisible();
    await expect(card.getByText("Only a superadmin can read an agent's version text.")).toBeVisible();
    await expect(card.getByRole("button", { name: "View SKILL.md" })).toBeDisabled();
  });

  test("an operator cannot retire a skill", async ({ page }) => {
    await page.goto("/panel/skills/agent%3Ascout%3Aweekly-digest?as=operator");
    await expect(page.getByText("Only a superadmin can retire or restore a skill.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retire skill" })).toBeDisabled();
  });

  test("guardrails list the owner's guardrails: scope, rules by kind, source, status and last fired", async ({ page }) => {
    await page.goto("/panel/guardrails");
    const table = page.getByRole("table", { name: "Guardrails" });
    const mail = table.getByRole("row").filter({ hasText: "no-outbound-email" });
    await expect(mail).toContainText("Every agent");
    await expect(mail).toContainText("Enforced: 2");
    await expect(mail).not.toContainText("Not yet enforced");
    await expect(mail).toContainText("Guidance");
    await expect(mail).toContainText("Deploy repo");
    await expect(mail).toContainText("On");
    const triage = table.getByRole("row").filter({ hasText: "triage-channels" });
    await expect(triage).toContainText("Only in #team-channel");
    await expect(triage).toContainText("Behind source");
    await expect(triage).toContainText("1 problem");
    await expect(table.getByRole("row").filter({ hasText: "invoice-care" })).toContainText("Guidance (on match)");
    await expect(page.getByText("a session cannot reach the database")).toBeVisible();
    // The runtime layer is no longer shown.
    await expect(page.getByText("Hooks and gates")).toHaveCount(0);
    await expect(page.getByText("System prompt", { exact: true })).toHaveCount(0);
    await mail.click();
    await expect(page).toHaveURL(/\/guardrails\/no-outbound-email$/);
  });

  test("a guardrail's detail: GUARDRAIL.md rendered and raw, rules labelled Enforced, Guidance, applies-to, firings", async ({ page }) => {
    await page.goto("/panel/guardrails/no-outbound-email");
    await expect(h1(page)).toHaveText("no-outbound-email");
    const rules = page.getByRole("table", { name: "Rules" });
    await expect(rules.getByRole("row").filter({ hasText: "no-send" })).toContainText("Enforced");
    await expect(rules.getByRole("row").filter({ hasText: "no-prices" })).toContainText("Enforced");
    await expect(rules.getByRole("row").filter({ hasText: "no-prices" })).not.toContainText("Not yet");
    await expect(page.getByText("Advisory", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy GUARDRAIL.md" })).toBeVisible();
    const card = page.locator(".sl-card").filter({ has: page.getByRole("button", { name: "Copy GUARDRAIL.md" }) });
    await card.getByRole("button", { name: "Raw" }).click();
    await expect(card.locator(".sl-md-raw")).toContainText("```rules");
    await card.getByRole("button", { name: "Rendered" }).click();
    await expect(page.getByRole("table", { name: "Recent firings" }).getByText("Denied a tool call")).toBeVisible();
    await expect(page.getByRole("link", { name: "triage" })).toHaveAttribute("href", "/panel/agents/triage/guardrails");
    await expect(page.getByText("Every channel")).toBeVisible();
    await page.goto("/panel/guardrails/triage-channels");
    await expect(page.getByText("is not a valid pattern")).toBeVisible();
    await expect(page.getByText("The source text changed after this override was written.")).toBeVisible();
    await page.goto("/panel/guardrails/missing");
    await expect(page.getByText("No such guardrail").first()).toBeVisible();
  });

  test("a superadmin turns a guardrail off and on; it leaves the agent's tab while off", async ({ page }) => {
    await page.goto("/panel/guardrails/invoice-care");
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
    await expect(toasts(page).getByText("Guardrail off")).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
    // In-app navigation: the dev stub keeps its state for the page's lifetime.
    await page.getByRole("link", { name: "scout" }).click();
    const tab = page.getByRole("table", { name: "Guardrails of this agent" });
    await expect(tab.getByText("no-outbound-email")).toBeVisible();
    await expect(tab.getByText("invoice-care")).toHaveCount(0);
    await page.goBack();
    await page.getByRole("button", { name: "Turn on" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(toasts(page).getByText("Guardrail on")).toBeVisible();
  });

  test("an operator reads guardrails and cannot switch them", async ({ page }) => {
    await page.goto("/panel/guardrails/no-outbound-email?as=operator");
    await expect(page.getByText("Only a superadmin can switch a guardrail on or off.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn off" })).toBeDisabled();
  });

  test("the agent's Guardrails tab lists shared and its own guardrails, linking to each", async ({ page }) => {
    await page.goto("/panel/agents/triage/guardrails");
    const t = page.getByRole("table", { name: "Guardrails of this agent" });
    await expect(t.getByRole("row").filter({ hasText: "no-outbound-email" })).toContainText("Shared");
    await expect(t.getByRole("row").filter({ hasText: "triage-channels" })).toContainText("This agent");
    await expect(page.getByText(/Always-loaded Guidance: \d+ of 4,000 characters/)).toBeVisible();
    await t.getByRole("link", { name: "triage-channels" }).click();
    await expect(page).toHaveURL(/\/guardrails\/triage-channels$/);
  });

  test("the soul and access settings left the Guardrails page for Access, Memory and Mandates", async ({ page }) => {
    await page.goto("/panel/guardrails");
    await expect(page.getByRole("table", { name: "Guardrails" }).getByText("no-outbound-email")).toBeVisible();
    await expect(page.getByText("Soul and access settings")).toHaveCount(0);
    await expect(page.locator("#settings-tool-permissions")).toHaveCount(0);

    // Access tab: approvers with scope words and the timeout, permission cards (deciders, threads per mode), admission, redaction.
    await page.goto("/panel/agents/default/access");
    await page.getByText("Approvals and permissions details").click();
    const approvals = page.locator("#settings-approvals");
    await expect(approvals.getByRole("table", { name: "Approvals" }).getByText("deploys")).toBeVisible();
    await expect(approvals.getByText("600 seconds")).toBeVisible();
    const cards = page.locator("#settings-tool-permissions");
    await expect(cards.getByRole("heading", { name: /Permission cards/ })).toBeVisible();
    await expect(cards.getByText("an approver or manager of this agent")).toBeVisible();
    await expect(cards.getByRole("table", { name: "Permission cards" }).getByText("acceptEdits")).toBeVisible();
    await expect(cards.getByText("Env", { exact: true })).toBeVisible();
    await expect(page.locator("#settings-admission").getByText("CTEAM")).toBeVisible();
    await expect(page.locator("#settings-redaction")).toBeVisible();
    await page.goto("/panel/agents/scout/access");
    await page.getByText("Approvals and permissions details").click();
    await expect(page.locator("#settings-approvals").getByText("UBOB")).toBeVisible();

    // Memory page: the write rules, per agent.
    await page.goto("/panel/memory");
    const rules = page.locator("#settings-memory-gating");
    await expect(page.getByRole("heading", { name: "Write rules" })).toBeVisible();
    await expect(rules.getByText("Shared writes")).toBeVisible();
    await expect(rules.getByText("agent-udefault")).toBeVisible();
    await page.getByRole("button", { name: /^Agent: / }).click();
    await page.getByRole("menuitemradio", { name: "scout" }).click();
    await expect(page).toHaveURL(/\/memory\?agent=scout$/);
    await expect(page.locator("#settings-memory-gating").getByText("agent-uscout")).toBeVisible();
    await expect(page.locator("#settings-profile-guard")).toBeVisible();

    // Mandates tab: proactive settings and caps, wake tools, budgets, and the learned rules on their own.
    await page.goto("/panel/agents/default/mandates");
    await expect(page.locator("#settings-proactive").getByText("22:00 to 07:00")).toBeVisible();
    await expect(page.locator("#settings-wake-tools")).toBeVisible();
    await expect(page.locator("#settings-budgets").getByText("2 USD")).toBeVisible();
    await expect(page.locator("#settings-learned-rules").getByText("ci red")).toBeVisible();
    // The policy family (never built) is gone.
    await expect(page.getByText("Policy guardrails")).toHaveCount(0);
  });

  test("the editor: create from a template, live validation errors, save", async ({ page }) => {
    await page.goto("/panel/guardrails");
    await page.getByRole("button", { name: "New guardrail" }).click();
    await expect(h1(page)).toHaveText("New guardrail");
    await page.getByLabel("Name", { exact: true }).fill("no-passwords");
    await page.getByLabel("Start from").selectOption("inbound-deny");
    const text = page.getByLabel("GUARDRAIL.md text");
    await expect(text).toHaveValue(/name: no-passwords/);
    const v = page.getByTestId("guardrail-validation");
    await expect(v.getByText("Valid", { exact: true })).toBeVisible();
    // An action an inbound rule cannot take refuses the save, inline.
    await text.fill((await text.inputValue()).replace("action: deny", "action: redact"));
    await expect(v.getByRole("list", { name: "Errors that refuse a save" })).toContainText("action redact is not available for on: inbound");
    await expect(page.getByRole("button", { name: "Create guardrail" })).toBeDisabled();
    await text.fill((await text.inputValue()).replace("action: redact", "action: deny"));
    await expect(v.getByText("Valid", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create guardrail" }).click();
    await expect(toasts(page).getByText("Guardrail created")).toBeVisible();
    await expect(page).toHaveURL(/\/guardrails\/no-passwords$/);
    await expect(page.getByRole("table", { name: "Rules" }).getByText("no-passwords")).toBeVisible();
    await expect(page.getByText("Console", { exact: true }).first()).toBeVisible();
    // A console guardrail can be deleted.
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(toasts(page).getByText("Guardrail deleted")).toBeVisible();
    await expect(page).toHaveURL(/\/guardrails$/);
    await expect(page.getByRole("table", { name: "Guardrails" }).getByText("no-passwords")).toHaveCount(0);
  });

  test("editing a deploy repo guardrail saves an override: badge, diff against the source, clear", async ({ page }) => {
    await page.goto("/panel/guardrails/no-outbound-email");
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit as override" }).click();
    await expect(h1(page)).toHaveText("Edit no-outbound-email");
    await expect(page.getByText("Saving writes a console override")).toBeVisible();
    const text = page.getByLabel("GUARDRAIL.md text");
    await text.fill((await text.inputValue()).replace("Never send it yourself.", "Never send it yourself, ever."));
    await expect(page.getByTestId("guardrail-validation").getByText("Valid", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save override" }).click();
    await expect(toasts(page).getByText("Override saved")).toBeVisible();
    await expect(page).toHaveURL(/\/guardrails\/no-outbound-email$/);
    await expect(page.getByText("Console override").first()).toBeVisible();
    const diff = page.getByLabel("Override diff against the source");
    await expect(diff.locator(".is-del")).toContainText("Never send it yourself.");
    await expect(diff.locator(".is-add")).toContainText("Never send it yourself, ever.");
    await page.getByRole("button", { name: "Clear override" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Clear override" }).click();
    await expect(toasts(page).getByText("Override cleared")).toBeVisible();
    await expect(page.getByLabel("Override diff against the source")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit as override" })).toBeVisible();
  });

  test("a behind-source override shows its diff against the new source", async ({ page }) => {
    await page.goto("/panel/guardrails/triage-channels");
    const diff = page.getByLabel("Override diff against the source");
    await expect(diff.locator(".is-del")).toContainText("Keep triage notes short and kind.");
    await expect(diff.locator(".is-add")).toContainText("Keep triage notes short.");
    await expect(page.locator(".sl-card").filter({ has: diff }).getByText("Behind source")).toBeVisible();
  });

  test("a stale save is refused and offers a reload", async ({ page, context }) => {
    await page.goto("/panel/guardrails/invoice-care/edit");
    const text = page.getByLabel("GUARDRAIL.md text");
    await expect(page.getByTestId("guardrail-validation").getByText("Valid", { exact: true })).toBeVisible();
    // Someone else saves first (the stub keeps one state per page, so change it through this page's API).
    await page.evaluate(async () => {
      const r = await fetch("/panel/api/guardrails/invoice-care", { method: "PUT", headers: { "content-type": "application/json", "x-panel-csrf": "1" }, body: JSON.stringify({ md: "---\nname: invoice-care\nload: on-match\ntriggers: { inbound: '(?i)invoice' }\n---\nTheirs.", revision: 5 }) });
      if (!r.ok) throw new Error(String(r.status));
    });
    void context;
    await text.fill((await text.inputValue()) + "\nMine.");
    await page.getByRole("button", { name: "Save override" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "changed since it was loaded" })).toBeVisible();
    await page.getByRole("button", { name: "Reload the saved version" }).click();
    await expect(text).toHaveValue(/Theirs\./);
    await expect(page.getByText("Your edits before the reload")).toBeVisible();
  });

  test("an operator reads the editor but cannot save, create or delete", async ({ page }) => {
    await page.goto("/panel/guardrails?as=operator");
    await expect(page.getByRole("button", { name: "New guardrail" })).toBeDisabled();
    await page.goto("/panel/guardrails/no-outbound-email?as=operator");
    await expect(page.getByText("Only a superadmin can edit, override or delete a guardrail.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit as override" })).toBeDisabled();
    await page.goto("/panel/guardrails/no-outbound-email/edit?as=operator");
    await expect(page.getByText("Only a superadmin can create or edit guardrails.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save override" })).toBeDisabled();
  });

  test("the Test box: a tool call, a reply, an inbound message and a draft", async ({ page }) => {
    await page.goto("/panel/guardrails");
    await page.getByRole("button", { name: "Test a guardrail" }).click();
    await expect(h1(page)).toHaveText("Test a guardrail");
    const form = page.getByRole("form", { name: "Test a guardrail" });
    await form.getByLabel("Tool name").fill("mcp__mail__send_message");
    await form.getByLabel("Tool input (JSON)").fill('{"to":"jane@example.com"}');
    await form.getByRole("button", { name: "Run test" }).click();
    const result = page.getByTestId("guardrail-test-result");
    await expect(result.getByText("Decision: Deny")).toBeVisible();
    await expect(result.getByRole("table", { name: "Matching rules" }).getByRole("row").filter({ hasText: "no-send" })).toContainText("Decides");
    await expect(result.getByText(/Always in the prompt: .*no-outbound-email/)).toBeVisible();

    await form.getByLabel("What").selectOption("inbound");
    await form.getByLabel("Message text").fill("can you send the invoice?");
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(result.getByText("No rule matched")).toBeVisible();
    await expect(result.getByText(/Delivered on match .*invoice-care/)).toBeVisible();

    await form.getByLabel("What").selectOption("reply");
    await form.getByLabel("Reply text").fill("Card 1234-5678-9012-3456 is on file.");
    await page.getByText("Try an unsaved draft").click();
    await form.getByLabel("Draft guardrail name").fill("hide-cards");
    await form.getByLabel("Draft GUARDRAIL.md").fill("---\nname: hide-cards\n---\n```rules\n- id: cards\n  on: reply\n  match: { text: '\\d{4}-\\d{4}-\\d{4}-\\d{4}' }\n  action: redact\n```");
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(result.getByText("Decision: Redact")).toBeVisible();
    await expect(result.getByText("Card [REDACTED] is on file.")).toBeVisible();
    await expect(result.getByRole("table", { name: "Matching rules" }).getByText("Draft", { exact: true })).toBeVisible();

    await form.getByLabel("What").selectOption("tool");
    await form.getByLabel("Tool input (JSON)").fill("{nope");
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not valid JSON" })).toBeVisible();
  });

  test("a guardrail stored as test (before the name was reserved) is reachable: list, detail, edit; /guardrails/test stays the Test box", async ({ page }) => {
    await page.goto("/panel/guardrails?stubReservedGuardrail=1");
    await page.getByRole("table", { name: "Guardrails" }).getByRole("row").filter({ hasText: "Stored before the name was reserved" }).click();
    await expect(page).toHaveURL(/\/guardrails\/~\/test$/);
    await expect(h1(page)).toHaveText("test");
    await expect(page.getByRole("table", { name: "Rules" }).getByText("no-tokens")).toBeVisible();
    await page.getByRole("button", { name: "Edit as override" }).click();
    await expect(page).toHaveURL(/\/guardrails\/~\/test\/edit$/);
    const text = page.getByLabel("GUARDRAIL.md text");
    await expect(page.getByTestId("guardrail-validation").getByText("Valid", { exact: true })).toBeVisible();
    await text.fill((await text.inputValue()).replace("Keep test notes short.", "Keep test notes shorter."));
    await expect(page.getByTestId("guardrail-validation").getByText("Valid", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save override" }).click();
    await expect(toasts(page).getByText("Override saved")).toBeVisible();
    await expect(page).toHaveURL(/\/guardrails\/~\/test$/);
    await expect(page.getByLabel("Override diff against the source").locator(".is-add")).toContainText("Keep test notes shorter.");
    await page.goto("/panel/guardrails/test");
    await expect(h1(page)).toHaveText("Test a guardrail");
  });

  test("the Test box on a guardrail's detail page", async ({ page }) => {
    await page.goto("/panel/guardrails/triage-channels");
    const form = page.getByRole("form", { name: "Test a guardrail" });
    await expect(form.getByLabel("Agent")).toHaveValue("triage");
    await form.getByLabel("What").selectOption("inbound");
    await form.getByLabel("Message text").fill("password: hunter2");
    await form.getByRole("button", { name: "Run test" }).click();
    const result = page.getByTestId("guardrail-test-result");
    await expect(result.getByText("Decision: Deny")).toBeVisible();
    await expect(result.getByText("Please do not paste passwords here.").first()).toBeVisible();
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

test("Users filters by state and opens a read-only detail drawer", async ({ page }) => {
  await page.goto("/panel/users");
  await settled(page, "j***@example.com");
  await expect(page.getByRole("main").getByText("Read only in this release", { exact: false })).toBeVisible();
  await expect(page.getByRole("main").getByText("Unmatched", { exact: true })).toBeVisible();
  await page.getByRole("cell", { name: /j\*\*\*@example.com/ }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("U3EXAMPLE");
  await expect(drawer).toContainText("Aliases");
  await expect(drawer.getByRole("button", { name: /merge|undo|resolve/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/panel/users?state=verified");
  await settled(page, "j***@example.com");
  await expect(page.getByRole("main").getByText("U1EXAMPLE")).toHaveCount(0);
});

test("Users is refused to an operator", async ({ page }) => {
  await page.goto("/panel/users?as=operator");
  await expect(page.getByRole("main").getByText("Your console role cannot see this.")).toBeVisible();
});

test("Merges lists the ledger, opens a detail with the limits, and undoes after a preview and a reason", async ({ page }) => {
  await page.goto("/panel/merges");
  await settled(page, "2 bindings, 1 grants");
  await expect(page.getByRole("main").getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText("Window passed")).toBeVisible();
  await page.getByRole("row").filter({ hasText: "Proof" }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("j***@example.com");
  await expect(drawer).toContainText("U0***LE");
  await expect(drawer).toContainText("Credentials and memory slices were never moved");
  await expect(drawer).toContainText("later-first");
  await expect(drawer).toContainText("A deleted account is not restored");
  await expect(drawer).toContainText("person sent; managers sent 1, failed 0");
  await drawer.getByRole("button", { name: "Undo this merge" }).click();
  const dialog = page.getByRole("dialog", { name: "Undo this merge?" });
  await expect(dialog.getByLabel("Undo preview")).toContainText("2 bindings, 1 grants");
  await expect(dialog).toContainText("link between the Slack account and the sign-in account will be removed");
  const confirm = dialog.getByRole("button", { name: "Undo merge" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason").fill("wrong person");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(toasts(page).getByText("Merge undone")).toBeVisible();
});

test("Merges: a failed notice says the merge stands, a past-window merge cannot be undone, the list filters", async ({ page }) => {
  await page.goto("/panel/merges");
  await settled(page, "2 bindings, 1 grants");
  await page.getByRole("row").filter({ hasText: "Console" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("The merge stands. The notice is not retried");
  await page.keyboard.press("Escape");
  await page.getByRole("row").filter({ hasText: "Window passed" }).first().click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Undo this merge" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /State/ }).click();
  await page.getByRole("menuitemradio", { name: "Undone" }).click();
  await expect(page.getByRole("main").getByText("2 bindings, 1 grants")).toHaveCount(1);
});

test("Merges is refused to an operator", async ({ page }) => {
  await page.goto("/panel/merges?as=operator");
  await expect(page.getByRole("main").getByText("Your console role cannot see this.")).toBeVisible();
});

test("Proposals: review lists the grants, the button needs the typed word, approve merges; a stale one cannot be reviewed", async ({ page }) => {
  await page.goto("/panel/proposals");
  await settled(page, "j***@example.com");
  await expect(page.getByRole("main").getByText("Stale")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "k***@example.com" }).getByRole("button", { name: "Review" })).toBeDisabled();
  await page.getByRole("row").filter({ hasText: "j***@example.com" }).getByRole("button", { name: "Review" }).click();
  const dialog = page.getByRole("dialog", { name: "Merge these records?" });
  await expect(dialog.getByLabel("Grants this merge would activate")).toContainText("scout:member:grant:g-1");
  const approve = dialog.getByRole("button", { name: "Approve merge" });
  await expect(approve).toBeDisabled();
  await dialog.getByLabel('Type "merge" to confirm').fill("merge");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(toasts(page).getByText("Records merged")).toBeVisible();
});

test("Proposals: dismiss asks first", async ({ page }) => {
  await page.goto("/panel/proposals");
  await settled(page, "j***@example.com");
  await page.getByRole("row").filter({ hasText: "j***@example.com" }).getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("dialog", { name: "Dismiss this proposal?" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(toasts(page).getByText("Proposal dismissed")).toBeVisible();
});

test("Boundaries shows an empty state", async ({ page }) => {
  await page.goto("/panel/boundaries?stubEmpty=1");
  await expect(page.getByRole("main").getByText("No boundaries yet")).toBeVisible();
});
