/**
 * Console API: Resources > Skills. Every source a skill reaches an agent
 * through (built-in, installed from the lock, bundled or local, an agent's
 * overlay, a Claude Code plugin, retired copies), which agents see it, usage,
 * and the superadmin retire and restore actions (agent-authored only, audited).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { readSkillFileSafe } from "../../src/gateway/panel/skills-view";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as SkillUsage from "../../src/db/skill-usage";
import * as Proposals from "../../src/db/proposals";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import { paths } from "../../src/config/home";
import { setAgentId, resetAgentId } from "../../src/knowledge/agent-identity";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import type { SkillDetailResponse, SkillsResponse, SkillSummaryView } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const operator = cookie("alice@example.com");
const superadmin = cookie("lead@example.com");

const panel = () => createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {} });
const call = async (method: string, path: string, who: string = operator, body?: unknown) => {
  const res = (await panel().fetch(
    new Request(`https://panel.example.com${path}`, {
      method,
      headers: { cookie: who, ...(method !== "GET" ? { "x-panel-csrf": "1", "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

function registryWith(names: string[]): PersonaRegistry {
  const full = names.map((name) => ({ name, slackUserId: `UP${name.toUpperCase()}`, config: { slackUserId: "UX", name }, outClient: null }) as unknown as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

function skill(dir: string, fm: Record<string, string>, body = "# Body\n\nSome **steps**.") {
  mkdirSync(dir, { recursive: true });
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${head}\n---\n${body}\n`);
}

const pluginDir = mkdtempSync(join(tmpdir(), "slaude-plugin-"));
const made: string[] = [];
const lockPath = join(paths.home, "slaude.lock");
const pluginsFile = join(paths.claudeConfig, "plugins", "installed_plugins.json");

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"];

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
  setAgentId("UDEFAULT");
  setPersonaRegistry(registryWith(["scout"]));
  await flushAudits();
  await db.run("DELETE FROM skill_usage");
  await db.run("DELETE FROM proposals");
  await db.run("DELETE FROM audit_events");

  // Base root: one installed from the lock, one the default persona wrote, one placed by hand.
  const triage = join(paths.skills, "triage-x");
  skill(triage, { name: "triage-x", description: "Sort the queue" });
  mkdirSync(join(triage, "scripts"), { recursive: true });
  writeFileSync(join(triage, "scripts", "run.sh"), "echo hi\n");
  skill(join(paths.skills, "notes-x"), { name: "notes-x", description: "Keep notes", authored_by: "agent", authored_at: "2026-11-01T00:00:00Z" });
  skill(join(paths.skills, "local-x"), { name: "local-x", description: "Placed by hand" });
  // scout's overlay: its own skill, and one shadowing the base triage-x.
  skill(join(paths.personas, "scout", "skills", "scout-x"), { name: "scout-x", description: "Scout only", authored_by: "agent" });
  skill(join(paths.personas, "scout", "skills", "triage-x"), { name: "triage-x", description: "Scout's triage" });
  made.push(triage, join(paths.skills, "notes-x"), join(paths.skills, "local-x"), join(paths.personas, "scout"));

  writeFileSync(lockPath, JSON.stringify({ version: 1, skills: { "triage-x": { git: "https://example.com/org/skills.git", ref: "main", sha: "a".repeat(40), path: "triage" } } }));
  skill(join(pluginDir, "skills", "search"), { name: "search", description: "Search the docs" });
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "docs-kit" }));
  mkdirSync(join(paths.claudeConfig, "plugins"), { recursive: true });
  writeFileSync(pluginsFile, JSON.stringify({ version: 2, plugins: { "docs-kit@market": [{ scope: "user", installPath: pluginDir, version: "1.2.0", gitCommitSha: "b".repeat(40) }] } }));

  await SkillUsage.record("UDEFAULT", "triage-x", 1000);
  await SkillUsage.record("UDEFAULT", "triage-x", 2000);
  await SkillUsage.record("UPSCOUT", "triage-x", 3000);
  await SkillUsage.record("UPSCOUT", "slaude:memory", 4000);
});

afterEach(async () => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(join(paths.skills, ".retired"), { recursive: true, force: true });
  rmSync(lockPath, { force: true });
  rmSync(pluginsFile, { force: true });
  __resetPersonaRegistry();
  resetAgentId();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
});
afterAll(() => rmSync(pluginDir, { recursive: true, force: true }));

const byId = (skills: SkillSummaryView[], id: string) => skills.find((s) => s.id === id);

describe("GET /panel/api/skills", () => {
  test("lists every source with origin, agents and usage", async () => {
    const r = await call("GET", "/panel/api/skills");
    expect(r.status).toBe(200);
    const { skills } = r.body as SkillsResponse;

    const memory = byId(skills, "builtin:memory")!;
    expect(memory).toMatchObject({ source: "built-in", invocation: "slaude:memory", status: "active", agents: ["default", "scout"] });
    expect(memory.usage.uses).toBe(1);

    const triage = byId(skills, "base:triage-x")!;
    expect(triage).toMatchObject({
      source: "installed",
      origin: { root: "base", repo: "https://example.com/org/skills.git", ref: "main", commit: "a".repeat(40), path: "triage" },
      agents: ["default"],
      shadowedFor: ["scout"],
    });
    // scout's uses count for its own overlay copy, not the shadowed base.
    expect(triage.usage).toEqual({ uses: 2, lastUsedAt: 2000, trackedSince: 1000 });
    expect(byId(skills, "agent:scout:triage-x")!.usage.uses).toBe(1);

    expect(byId(skills, "base:notes-x")).toMatchObject({ source: "agent-authored", origin: { authoredBy: "default", authoredAt: "2026-11-01T00:00:00Z" } });
    expect(byId(skills, "base:local-x")).toMatchObject({ source: "installed", origin: { local: true } });
    expect(byId(skills, "agent:scout:scout-x")).toMatchObject({ source: "agent-authored", agents: ["scout"], origin: { root: "agent", authoredBy: "scout" } });
    expect(byId(skills, "plugin:docs-kit:search")).toMatchObject({
      source: "plugin",
      invocation: "docs-kit:search",
      origin: { plugin: "docs-kit", marketplace: "market", version: "1.2.0", commit: "b".repeat(40) },
      agents: ["default", "scout"],
    });
    // Never a path on disk.
    expect(JSON.stringify(r.body)).not.toContain(paths.home);
  });

  test("a skill's detail: frontmatter, body, files, usage", async () => {
    const r = await call("GET", `/panel/api/skills/${encodeURIComponent("base:triage-x")}`);
    expect(r.status).toBe(200);
    const d = r.body as SkillDetailResponse;
    expect(d.frontmatter).toEqual({ name: "triage-x", description: "Sort the queue" });
    expect(d.body).toContain("Some **steps**.");
    expect(d.raw.startsWith("---\n")).toBe(true);
    expect(d.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(d.usageHistory).toEqual([{ agent: "default", key: "triage-x", uses: 2, lastUsedAt: 2000, firstSeenAt: 1000 }]);
    expect(d.actions).toEqual({ retire: false, restore: false });
    expect((await call("GET", "/panel/api/skills/base%3Anope")).status).toBe(404);
  });
});

describe("SKILL.md reads are confined", () => {
  test("a symlinked SKILL.md pointing outside the skill dir is not read", async () => {
    const outside = mkdtempSync(join(tmpdir(), "slaude-secret-"));
    writeFileSync(join(outside, "secret.md"), "---\nname: leak\ndescription: TOP-SECRET-CONTENT\n---\nTOP-SECRET-CONTENT\n");
    const dir = join(paths.skills, "linky-x");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, "secret.md"), join(dir, "SKILL.md"));
    made.push(dir, outside);
    const list = await call("GET", "/panel/api/skills");
    expect(JSON.stringify(list.body)).not.toContain("TOP-SECRET-CONTENT");
    const d = (await call("GET", "/panel/api/skills/base%3Alinky-x")).body as SkillDetailResponse;
    expect(d.raw).toBe("");
    expect(d.rawUnreadable).toContain("symlink");
    expect(JSON.stringify(d)).not.toContain("TOP-SECRET-CONTENT");
  });

  test("an oversized SKILL.md is cut at 256 KB and flagged", async () => {
    const dir = join(paths.skills, "huge-x");
    skill(dir, { name: "huge-x", description: "big" }, "x".repeat(300 * 1024));
    made.push(dir);
    const d = (await call("GET", "/panel/api/skills/base%3Ahuge-x")).body as SkillDetailResponse;
    expect(d.rawTruncated).toBe(true);
    expect(Buffer.byteLength(d.raw)).toBe(256 * 1024);
    expect(d.description).toBe("big");
  });

  test("readSkillFileSafe refuses a file whose real path leaves the dir through a symlinked parent", () => {
    const outside = mkdtempSync(join(tmpdir(), "slaude-out-"));
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "SKILL.md"), "secret");
    const dir = mkdtempSync(join(tmpdir(), "slaude-skill-"));
    symlinkSync(join(outside, "sub"), join(dir, "sub"));
    made.push(outside, dir);
    expect(readSkillFileSafe(dir, "sub/SKILL.md")).toEqual({ ok: false, reason: "outside the skill directory, not read" });
  });
});

describe("plugin skill usage", () => {
  test("counts every key the runtime records for it: plugin and CLI name, plugin and directory, and the bare name when unique", async () => {
    await SkillUsage.record("UDEFAULT", "docs-kit:search", 10);
    await SkillUsage.record("UPSCOUT", "search", 20);
    // A bare name another skill also answers to is not counted for the plugin.
    await SkillUsage.record("UDEFAULT", "triage-x", 30);
    const { skills } = (await call("GET", "/panel/api/skills")).body as SkillsResponse;
    expect(byId(skills, "plugin:docs-kit:search")!.usage).toEqual({ uses: 2, lastUsedAt: 20, trackedSince: 10 });
  });

  test("a plugin skill whose frontmatter name differs from its directory counts under both", async () => {
    skill(join(pluginDir, "skills", "lookup"), { name: "Find Things", description: "Find" });
    try {
      await SkillUsage.record("UDEFAULT", "docs-kit:Find-Things", 10);
      await SkillUsage.record("UDEFAULT", "docs-kit:lookup", 20);
      const { skills } = (await call("GET", "/panel/api/skills")).body as SkillsResponse;
      expect(byId(skills, "plugin:docs-kit:lookup")).toMatchObject({ invocation: "docs-kit:Find-Things", usage: { uses: 2 } });
    } finally {
      rmSync(join(pluginDir, "skills", "lookup"), { recursive: true, force: true });
    }
  });
});

describe("retire and restore", () => {
  test("operators cannot; installed skills cannot be retired", async () => {
    expect((await call("POST", "/panel/api/skills/agent%3Ascout%3Ascout-x/retire", operator, {})).status).toBe(403);
    const installed = await call("POST", "/panel/api/skills/base%3Atriage-x/retire", superadmin, {});
    expect(installed.status).toBe(409);
  });

  test("a superadmin retires an agent-authored skill and restores it, both audited", async () => {
    const r = await call("POST", "/panel/api/skills/agent%3Ascout%3Ascout-x/retire", superadmin, { reason: "never used" });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^retired:scout:scout-x-\d{8}T\d{6}Z$/);
    expect(existsSync(join(paths.personas, "scout", "skills", "scout-x"))).toBe(false);

    const list = (await call("GET", "/panel/api/skills")).body as SkillsResponse;
    const retired = byId(list.skills, r.body.id)!;
    expect(retired).toMatchObject({ status: "retired", agents: [], source: "agent-authored" });
    const detail = (await call("GET", `/panel/api/skills/${encodeURIComponent(r.body.id)}`)).body as SkillDetailResponse;
    expect(detail.actions).toEqual({ retire: false, restore: true });
    // The retirement row names the operator, not the skill review.
    expect(detail.proposals).toMatchObject([{ kind: "skill-retired", status: "approved", agent: "scout", reason: "never used", decidedBy: "lead@example.com" }]);

    const back = await call("POST", `/panel/api/skills/${encodeURIComponent(r.body.id)}/restore`, superadmin);
    expect(back.status).toBe(200);
    expect(back.body.id).toBe("agent:scout:scout-x");
    expect(existsSync(join(paths.personas, "scout", "skills", "scout-x", "SKILL.md"))).toBe(true);
    const rows = await Proposals.listSkillProposals();
    expect(rows[0]).toMatchObject({ kind: "skill-retired", status: "rejected", decidedBy: "lead@example.com" });

    await flushAudits();
    const audit = (await AuditEvents.list({})).items.filter((e) => e.action.startsWith("skill."));
    expect(audit.map((e) => [e.action, e.actorId, e.persona, e.targetId])).toEqual([
      ["skill.restored", "lead@example.com", "scout", "scout-x"],
      ["skill.retired", "lead@example.com", "scout", "scout-x"],
    ]);
  });
});
