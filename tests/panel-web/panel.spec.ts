import { test, expect } from "@playwright/test";

const OP = "ops@slaude.dev";
const list = (extra = "") => `/panel/?op=${encodeURIComponent(OP)}${extra}`;
const detail = (id: string, extra = "") => `/panel/?op=${encodeURIComponent(OP)}${extra}#/s/${id}`;

test("list renders the fleet and filters narrow it", async ({ page }) => {
  await page.goto(list());
  const rows = page.locator("tbody tr[data-sid]");
  await expect(rows).toHaveCount(8);

  // persona filter
  await page.selectOption('[aria-label="Filter persona"]', "ravi");
  await expect(page.locator("tbody tr[data-sid]")).toHaveCount(2);
  await page.selectOption('[aria-label="Filter persona"]', "");

  // status filter via the summary stat chip
  await page.getByRole("button", { name: /Running/ }).first().click();
  for (const r of await page.locator("tbody tr[data-sid]").all()) {
    await expect(r).toHaveAttribute("data-status", "running");
  }
});

test("clicking a row opens the session detail", async ({ page }) => {
  await page.goto(list());
  await page.locator('tr[data-sid="s_ravi_9f3c21"]').click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
  await expect(page.locator(".ident-title")).toContainText("settlement");
});

test("changing model issues a control POST with the right body", async ({ page }) => {
  await page.goto(detail("s_ravi_9f3c21"));
  await expect(page.locator('[data-testid="controlbar"]')).toBeVisible();
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/control") && r.method() === "POST"),
    page.selectOption('[data-testid="sel-model"]', "claude-haiku-4-5"),
  ]);
  expect(JSON.parse(req.postData() || "{}")).toMatchObject({ action: "model", model: "claude-haiku-4-5" });
});

test("request-stop requires a reason then posts action:stop", async ({ page }) => {
  await page.goto(detail("s_ravi_9f3c21"));
  await page.locator('[data-testid="btn-stop"]').click();
  const confirm = page.locator('[data-testid="confirm-action"]');
  await expect(confirm).toBeDisabled(); // honest destructive control: reason gated
  await page.locator("#reason").fill("runaway loop, halting");
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/control") && r.method() === "POST"),
    confirm.click(),
  ]);
  expect(JSON.parse(req.postData() || "{}")).toMatchObject({ action: "stop" });
});

test("SSE frames render as visual timeline nodes", async ({ page }) => {
  await page.goto(detail("s_ravi_9f3c21"));
  await expect(page.locator('[data-testid="tl-node"]').first()).toBeVisible();
  await expect.poll(async () => page.locator('[data-testid="tl-node"]').count(), { timeout: 8000 }).toBeGreaterThanOrEqual(8);
  // typed nodes carry their event kind
  await expect(page.locator('[data-ev="toolCall"]').first()).toBeVisible();
});

test("take-control shows lock state and release clears it", async ({ page }) => {
  await page.goto(detail("s_toko_1c9d55"));
  await page.locator('[data-testid="tab-chat"]').click();
  await page.locator('[data-testid="take-control"]').click();
  const banner = page.locator('[data-testid="lock-banner"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You hold this session");
  await page.locator('[data-testid="release"]').click();
  await expect(page.locator('[data-testid="lock-banner"]')).toHaveCount(0);
});

test("409 surfaces the current owner when another operator holds the lock", async ({ page }) => {
  await page.goto(detail("s_lena_47ab08")); // fixture: locked by maya@slaude.dev
  await expect(page.locator('[data-testid="lock-banner"]')).toContainText("maya@slaude.dev");
  await page.locator('[data-testid="tab-chat"]').click();
  await page.locator('[data-testid="take-control"]').click();
  await expect(page.locator('[data-testid="chat-error"]')).toContainText("maya@slaude.dev");
});

test("503 (no Redis) disables stop with an explanation", async ({ page }) => {
  await page.goto(detail("s_ravi_9f3c21", "&mock=1&noredis=1"));
  await expect(page.locator('[data-testid="btn-stop"]')).toBeDisabled();
  await expect(page.locator('[data-testid="notice-503"]')).toBeVisible();
});

test("retries once through /panel/auth/refresh on a 401", async ({ page }) => {
  let refreshes = 0;
  let expired = true;
  await page.route("**/panel/auth/refresh", async (route) => {
    refreshes++;
    expired = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/panel/api/sessions*", async (route) => {
    if (expired) {
      await route.fulfill({
        status: 401, contentType: "application/json",
        body: JSON.stringify({ error: "session expired" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/panel/");
  await expect(page.locator("tbody tr[data-sid]").first()).toBeVisible();
  expect(refreshes).toBe(1);
});

// ---------------------------------------------------------------- auth e2e --
// These drive a real login: the stub server serves /panel/auth/* and the app
// shell from the production panel handler, and /idp/* is an auto-approving
// stub provider. `?role=` picks which identity that provider signs in as —
// alice@ (operator), lead@ (superadmin), eve@ (on no role list).

const row = () => "tbody tr[data-sid]";

test("an unauthenticated visit lands on the fleet list after the provider round trip", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel");
  // stub provider auto-approves and bounces straight back to the callback
  await expect(page.locator(row()).first()).toBeVisible();
  await expect(page.locator(".identity-email")).toHaveText("alice@example.com");
  await expect(page.locator(".role-badge")).toHaveText(/operator/i);
});

test("an operator sees superadmin controls disabled", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=operator");
  await page.locator(row()).first().click();
  const reset = page.locator('[data-testid="btn-reset"]');
  await expect(reset).toBeDisabled();
  await expect(reset).toHaveAttribute("title", /superadmin/i);
});

test("a superadmin can issue reset", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=superadmin");
  await expect(page.locator(".role-badge")).toHaveText(/superadmin/i);
  await page.locator(row()).first().click();
  const reset = page.locator('[data-testid="btn-reset"]');
  await expect(reset).toBeEnabled();
  await reset.click();
  await page.locator("#reason").fill("stuck session, booting a fresh process");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/control") && r.request().method() === "POST"),
    page.locator('[data-testid="confirm-action"]').click(),
  ]);
  expect(res.status()).toBe(200); // the server's role gate let it through
  await expect(page.locator(".notice-forbidden")).toHaveCount(0);
});

test("an unlisted identity is refused and never gets a session", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=unlisted");
  // The panel denies at the callback, before minting any cookie: the browser
  // never reaches the app shell, so there is no fleet to see.
  await expect(page.locator("body")).toContainText(/not authorized/i);
  await expect(page.locator(row())).toHaveCount(0);
  const jar = await page.context().cookies();
  expect(jar.map((c) => c.name)).not.toContain("panel_at");
});

test("an identity dropped from the role lists gets the not-authorized screen", async ({ page, request }) => {
  await page.context().clearCookies();
  await page.goto("/panel?role=operator");
  await expect(page.locator(row()).first()).toBeVisible();
  try {
    // alice loses her operator listing while the page is open; the list's
    // 3s auto-refresh is the request that comes back 403.
    await request.post("/idp/operators?list=");
    await expect(page.locator(".notice-forbidden")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(row())).toHaveCount(0);
  } finally {
    await request.post("/idp/operators?list=alice%40example.com");
  }
});

test("a mid-session expiry refreshes the cookie and reopens the tail with the last id", async ({ page, request }) => {
  // The server ends the SSE tail at the access token's expiry with a named
  // `session-expired` frame. EventSource's own reconnect would hit the guard's
  // 401 and close for good, so the client must do the handshake: refresh, then
  // reopen from the last event it saw. 15 minutes compressed into one frame by
  // the stub's /idp/expire-sse.
  await page.context().clearCookies();
  let refreshes = 0;
  page.on("request", (r) => {
    if (r.url().includes("/panel/auth/refresh") && r.method() === "POST") refreshes++;
  });

  await page.goto("/panel?role=operator");
  await page.locator(row()).first().click();
  await expect(page.locator('[data-testid="tl-node"]').first()).toBeVisible();

  const reopened = page.waitForRequest((r) => /\/events\?lastId=/.test(r.url()), { timeout: 20_000 });
  await request.post("/idp/expire-sse");
  const again = await reopened;
  expect(again.url()).toMatch(/lastId=stub-\d+/);
  expect(refreshes).toBeGreaterThanOrEqual(1);
});
