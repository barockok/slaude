// Screenshots of the console and portal main pages, light and dark, at 1440
// and 390 px wide (deviceScaleFactor 1), on their dev stubs (VITE_STUB=1).
//
//   SHOTS_DIR=/some/dir bun run panel:shots
//
// SHOTS_DIR is required (screenshots never land in the repo). PW_CHROMIUM_PATH
// optionally points at a local Chromium, as in playwright.config.ts.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.env.SHOTS_DIR) {
  console.error("Set SHOTS_DIR to the directory the screenshots go to.");
  process.exit(2);
}
const OUT = resolve(process.env.SHOTS_DIR);
mkdirSync(OUT, { recursive: true });

const APPS = [
  {
    name: "console", script: "panel:dev", port: 4330, base: "/panel/",
    pages: [
      ["overview", "", "Bash: run the test suite"],
      ["agents", "agents", "triage"],
      ["agent-access", "agents/scout/access", "Covering approvals this week"],
      ["sessions", "sessions", "Compare queue libraries"],
      ["users", "users", "j***@example.com"],
      ["boundaries", "boundaries", "C1EXAMPLE"],
      ["session-timeline", "sessions/s_7f21", "Allowed Bash: run the test suite"],
      ["audit", "audit", "Bash: run the test suite"],
      ["access", "access", "bob@example.com"],
      ["memory", "memory", "kb-handbook"],
      ["memory-page", "memory/shared/page?slug=runbooks%2Fdeploy-rollback", "Announce the rollback"],
      ["environments", "environments", "node-g1"],
    ],
  },
  {
    name: "portal", script: "portal:dev", port: 4331, base: "/portal/",
    pages: [
      ["account", "", "TSANDBOX"],
      ["integrations", "integrations", "docs-wiki"],
      ["my-agents", "agents", "triage"],
    ],
  },
];
const SIZES = [[1440, 900], [390, 844]];
const THEMES = ["light", "dark"];

const servers = APPS.map((a) =>
  spawn("bun", ["run", a.script, "--port", String(a.port), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, VITE_STUB: "1" }, stdio: "ignore",
  }));
const stop = () => servers.forEach((s) => { try { s.kill(); } catch {} });
process.on("exit", stop);

async function waitUp(url) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never came up`);
}

async function run() {
  await Promise.all(APPS.map((a) => waitUp(`http://localhost:${a.port}${a.base}`)));
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  let n = 0;
  for (const app of APPS) {
    for (const theme of THEMES) {
      for (const [width, height] of SIZES) {
        const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
        await ctx.addInitScript((t) => { try { localStorage.setItem("slaude.theme", t); } catch {} }, theme);
        const page = await ctx.newPage();
        for (const [name, path, ready] of app.pages) {
          await page.goto(`http://localhost:${app.port}${app.base}${path}`);
          await page.getByRole("main").getByText(ready).first().waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".sl-skeleton, tr.is-skeleton").length === 0);
          await page.screenshot({ path: join(OUT, `${app.name}-${name}-${width}-${theme}.png`), fullPage: true });
          n++;
        }
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log(`${n} screenshots in ${OUT}`);
}

run().then(() => { stop(); process.exit(0); }, (e) => { console.error(e); stop(); process.exit(1); });
