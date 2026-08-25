// Renders the 5 panel views in light + dark against the fixture stub (mock
// mode, no live backend) and writes 1440x900 @2x PNGs into shots/. These are
// what the critic compares to bar/temporal-*.png.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "shots");
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const stub = spawn("bun", ["tests/panel-web/stub-server.ts"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit",
});
const die = () => { try { stub.kill(); } catch {} };
process.on("exit", die);

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/panel/`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("stub never came up");
}

const DETAIL = "s_ravi_9f3c21";
const LOCKED = "s_lena_47ab08";

async function run() {
  await waitUp();
  const browser = await chromium.launch();

  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    let nonce = 0;
    // unique nonce per nav so a hash-only change still forces a full reload
    const q = () => `?mock=1&theme=${theme}&n=${++nonce}`;
    const shot = (name) => page.screenshot({ path: join(OUT, `${name}-${theme}.png`) });
    const settleTimeline = async () => {
      // let the scripted SSE tail drain into nodes
      await page.waitForSelector('[data-testid="tl-node"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="tl-node"]').length >= 8, null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
    };

    // 1. list
    await page.goto(`${BASE}/panel/${q()}`, { waitUntil: "networkidle" });
    await page.waitForSelector("tbody tr[data-sid]");
    await page.waitForTimeout(300);
    await shot("list");

    // 2. detail — identity + metadata + control bar + lock banner
    await page.goto(`${BASE}/panel/${q()}#/s/${LOCKED}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-view="detail"]');
    await page.waitForTimeout(500);
    await shot("detail");

    // 3. timeline — the visual event tail
    await page.goto(`${BASE}/panel/${q()}#/s/${DETAIL}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-view="detail"]');
    await settleTimeline();
    await page.locator(".card[data-view='timeline']").scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot("timeline");

    // 4. controls — honest destructive control (reason-required stop modal)
    await page.goto(`${BASE}/panel/${q()}#/s/${DETAIL}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="controlbar"]');
    await page.locator('[data-testid="btn-stop"]').click();
    await page.waitForSelector(".modal");
    await page.locator("#reason").fill("runaway tool loop, halting at next safe point");
    await page.waitForTimeout(250);
    await shot("controls");

    // 5. chat — take control + conversation
    await page.goto(`${BASE}/panel/${q()}#/s/${DETAIL}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="tab-chat"]').click();
    await page.locator('[data-testid="take-control"]').click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('[data-testid="chat-input"]').fill("Post the diff in this thread first, then open the PR.").catch(() => {});
    await page.waitForTimeout(500);
    await shot("chat");

    await ctx.close();
  }

  await browser.close();
  console.log("shots written to", OUT);
}

run().then(() => { die(); process.exit(0); }).catch((e) => { console.error(e); die(); process.exit(1); });
