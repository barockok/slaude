import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 4319;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Drives the real built dist against the Bun fixture stub (stub-server.ts).
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "bun tests/panel-web/stub-server.ts",
    cwd: ROOT,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
