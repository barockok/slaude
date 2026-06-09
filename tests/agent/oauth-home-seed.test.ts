import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { ensureInitiatorConfigDir } from "../../src/agent/oauth-home";

describe("ensureInitiatorConfigDir", () => {
  const userId = "U_SEED_TEST";
  const dir = join(paths.home, "oauth", userId);
  beforeEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it("preserves a pre-existing initiator .credentials.json (no scrub)", () => {
    mkdirSync(dir, { recursive: true });
    const cred = join(dir, ".credentials.json");
    writeFileSync(cred, JSON.stringify({ mcpOAuth: { "x|abc": { accessToken: "t" } } }));
    ensureInitiatorConfigDir(userId);
    expect(existsSync(cred)).toBe(true);
  });

  it("copies settings.local.json from the agent config dir", () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ k: 1 }));
    ensureInitiatorConfigDir(userId);
    expect(existsSync(join(dir, "settings.local.json"))).toBe(true);
  });
});
