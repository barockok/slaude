/**
 * src/server.ts refuses to start on a security switch it cannot read
 * (securitySwitchViolations): an unknown spelling must never be read as off.
 * server.ts runs on import, so it is spawned, with an empty home and no
 * inherited environment, and bounded.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "..", "src", "server.ts");

async function boot(extra: Record<string, string>): Promise<{ code: number | null; err: string }> {
  const home = mkdtempSync(join(tmpdir(), "slaude-switch-"));
  try {
    const proc = Bun.spawn([process.execPath, SERVER], {
      cwd: home, // no project .env is auto-loaded from here
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SLAUDE_HOME: home, ...extra },
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, err };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("server.ts refuses an unreadable security switch at boot", () => {
  for (const [role, name] of [["mono", "SLAUDE_DEPLOY_STRICT"], ["gateway", "SLAUDE_NODE_LEGACY"]] as const) {
    test(`${role}: ${name}=loose stops the boot, naming the variable`, async () => {
      const { code, err } = await boot({ SLAUDE_ROLE: role, [name]: "loose" });
      expect(code).not.toBe(0);
      expect(err).toContain("refusing to start");
      expect(err).toContain(name);
    }, 40_000);
  }
});
