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
