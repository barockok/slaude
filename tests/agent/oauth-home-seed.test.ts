import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, lstatSync, realpathSync, symlinkSync, readlinkSync } from "node:fs";
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

  it("replaces a stale symlink pointing at the wrong target", () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    mkdirSync(agentProjects, { recursive: true });
    mkdirSync(dir, { recursive: true });
    // Plant a symlink pointing somewhere else (simulates pre-fix stale link)
    const staleTarget = join(dir, "_stale_target");
    mkdirSync(staleTarget, { recursive: true });
    const linked = join(dir, "projects");
    symlinkSync(staleTarget, linked, "dir");
    expect(readlinkSync(linked)).toBe(staleTarget);

    ensureInitiatorConfigDir(userId);

    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(realpathSync(agentProjects));
  });

  it("repairs a DANGLING symlink whose target has gone away", () => {
    // Regression: existsSync() follows symlinks, so a link pointing at a config
    // home that no longer exists read as "missing", symlinkSync then threw
    // EEXIST into a swallowed catch, and the dangling link survived every boot
    // — locked threads had nowhere to write a transcript, so every /1on1 resume
    // silently cold-started. See the 2026-09-11 field note.
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    mkdirSync(agentProjects, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const goneTarget = join(dir, "_gone_target");
    mkdirSync(goneTarget, { recursive: true });
    const linked = join(dir, "projects");
    symlinkSync(goneTarget, linked, "dir");
    rmSync(goneTarget, { recursive: true, force: true });
    expect(existsSync(linked)).toBe(false); // dangling: the trap the old guard fell into

    ensureInitiatorConfigDir(userId);

    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(realpathSync(agentProjects));
  });

  it("migrates a pre-existing real projects/ dir into the base home, then links", () => {
    // A home that predates the symlink fix must HEAL, not stay sharded forever:
    // leaving it real meant every later lock flip lost context for that user,
    // which reads exactly like the original bug never having been fixed.
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    mkdirSync(agentProjects, { recursive: true });
    mkdirSync(join(dir, "projects", "-slug"), { recursive: true });
    writeFileSync(join(dir, "projects", "-slug", "legacy.jsonl"), "LEGACY");

    ensureInitiatorConfigDir(userId);

    const linked = join(dir, "projects");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(realpathSync(agentProjects));
    // the legacy transcript moved into the base home — reachable through the link
    expect(readFileSync(join(agentProjects, "-slug", "legacy.jsonl"), "utf8")).toBe("LEGACY");
    expect(readFileSync(join(linked, "-slug", "legacy.jsonl"), "utf8")).toBe("LEGACY");
  });

  it("never overwrites on migration: a colliding transcript is parked, not dropped", () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
    const agentProjects = join(agentDir, "projects");
    mkdirSync(join(agentProjects, "-slug"), { recursive: true });
    writeFileSync(join(agentProjects, "-slug", "dup.jsonl"), "BASE");
    mkdirSync(join(dir, "projects", "-slug"), { recursive: true });
    writeFileSync(join(dir, "projects", "-slug", "dup.jsonl"), "LEGACY");

    ensureInitiatorConfigDir(userId);

    // base copy wins (it is what unlocked turns read)...
    expect(readFileSync(join(agentProjects, "-slug", "dup.jsonl"), "utf8")).toBe("BASE");
    // ...and the legacy copy is parked next to the link, never deleted
    const parked = readdirSync(dir).find((n) => n.startsWith("projects.legacy-"));
    expect(parked).toBeDefined();
    expect(readFileSync(join(dir, parked!, "-slug", "dup.jsonl"), "utf8")).toBe("LEGACY");
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
  });

});
