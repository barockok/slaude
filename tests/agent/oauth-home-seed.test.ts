import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, lstatSync, realpathSync } from "node:fs";
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

  it("symlinks projects/ to the agent's transcript home so resume survives lock flips", () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    mkdirSync(agentProjects, { recursive: true });
    writeFileSync(join(agentProjects, "transcript-marker.jsonl"), "{}");

    ensureInitiatorConfigDir(userId);

    const linked = join(dir, "projects");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(realpathSync(agentProjects));
    // a transcript written under the agent home is visible through the link
    expect(existsSync(join(linked, "transcript-marker.jsonl"))).toBe(true);
  });

  it("creates the agent projects/ dir if missing before linking (locked-first thread)", () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    rmSync(agentProjects, { recursive: true, force: true });

    ensureInitiatorConfigDir(userId);

    expect(existsSync(agentProjects)).toBe(true);
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
  });

  it("leaves a pre-existing real projects/ dir untouched (legacy initiator home)", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(join(dir, "projects", "legacy.jsonl"), "{}");

    ensureInitiatorConfigDir(userId);

    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, "projects", "legacy.jsonl"))).toBe(true);
  });
});
