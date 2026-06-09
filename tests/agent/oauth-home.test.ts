import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import {
  agentConfigDir,
  initiatorConfigDir,
  ensureInitiatorConfigDir,
  resolveSessionConfigDir,
} from "../../src/agent/oauth-home";

let agentDir: string;
const prevEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "agent-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = agentDir;
  // Agent config dir holds non-secret settings + plugins AND credential files.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledPlugins: ["x"] }));
  mkdirSync(join(agentDir, "plugins"), { recursive: true });
  writeFileSync(join(agentDir, "plugins", "marker.txt"), "plugin");
  writeFileSync(join(agentDir, ".credentials.json"), "AGENT-SECRET");
  writeFileSync(join(agentDir, "mcp-needs-auth-cache.json"), "AGENT-MCP-TOKEN");
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  try { rmSync(agentDir, { recursive: true, force: true }); } catch {}
  try { rmSync(join(paths.home, "oauth"), { recursive: true, force: true }); } catch {}
});

describe("oauth-home", () => {
  it("agentConfigDir honors CLAUDE_CONFIG_DIR", () => {
    expect(agentConfigDir()).toBe(agentDir);
  });

  it("initiatorConfigDir is per-user under $SLAUDE_HOME/oauth", () => {
    expect(initiatorConfigDir("U0ALICE")).toBe(join(paths.home, "oauth", "U0ALICE"));
  });

  it("seeds settings + plugins but NEVER credentials", () => {
    const dir = ensureInitiatorConfigDir("U0ALICE");
    // settings copied
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).enabledPlugins).toEqual(["x"]);
    // plugins reachable (symlink or copy)
    expect(existsSync(join(dir, "plugins", "marker.txt"))).toBe(true);
    // credential files must not leak into the initiator home
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(dir, "mcp-needs-auth-cache.json"))).toBe(false);
  });

  it("is idempotent and PRESERVES the initiator's own .credentials.json", () => {
    // The initiator dir is meant to hold the initiator's own OAuth token store
    // (written by the /mcp connect flow). ensureInitiatorConfigDir runs on every
    // locked-session boot, so it must NOT scrub that file. See finding
    // 2026-06-09-mcp-oauth-connect-1on1.
    const dir = initiatorConfigDir("U0BOB");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { "w|abc": { accessToken: "t" } } }));
    ensureInitiatorConfigDir("U0BOB");
    expect(existsSync(join(dir, ".credentials.json"))).toBe(true);
    // second call doesn't throw and still preserves the token store
    expect(ensureInitiatorConfigDir("U0BOB")).toBe(dir);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(true);
  });

  it("resolveSessionConfigDir: unlocked inherits (undefined), locked → initiator home", () => {
    expect(resolveSessionConfigDir(null)).toBeUndefined();
    expect(resolveSessionConfigDir(undefined)).toBeUndefined();
    expect(resolveSessionConfigDir("U0ALICE")).toBe(join(paths.home, "oauth", "U0ALICE"));
  });
});
