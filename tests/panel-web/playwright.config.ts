import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSOLE_PORT = 4320;
const PORTAL_PORT = 4321;

// Smoke tests for the operator console (/panel) and the portal (/portal). Each
// app runs on its Vite dev server with VITE_STUB=1, so a fetch interceptor over
// the dev fixtures (src/web/{console,portal}/dev) stands in for the gateway.
// The stub is dev only, which is why these drive the dev servers, not a build.
//
// PW_CHROMIUM_PATH points Playwright at a local Chromium (for example an
// installed headless shell whose build differs from this @playwright/test);
// unset, Playwright uses the browser it installed (`playwright install chromium`).
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

const server = (script: string, port: number, base: string) => ({
  command: `bun run ${script} --port ${port} --strictPort`,
  cwd: ROOT,
  url: `http://localhost:${port}${base}`,
  env: { VITE_STUB: "1" },
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
});

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "off",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "console", testMatch: /console\.spec\.ts/, use: { baseURL: `http://localhost:${CONSOLE_PORT}` } },
    { name: "portal", testMatch: /portal\.spec\.ts/, use: { baseURL: `http://localhost:${PORTAL_PORT}` } },
  ],
  webServer: [server("panel:dev", CONSOLE_PORT, "/panel/"), server("portal:dev", PORTAL_PORT, "/portal/")],
});
