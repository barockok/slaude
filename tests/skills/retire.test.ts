/**
 * Skill provenance, soft retire/restore and usage counting (spec §9.1 "Skill
 * retirement scope", §7a.5): write_skill stamps `authored_by: agent` itself;
 * slaude.lock and the bundled seed win over the stamp; a retired skill moves
 * to `<root>/.retired/<slug>-<UTC>/` and is neither loaded nor listed; a
 * successful Skill call is counted, best effort.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import { bootstrapSqliteSchema } from "../../src/db/drivers/sqlite";
import * as SkillUsage from "../../src/db/skill-usage";
import { buildSkillMd, makeSkillHandlers, skillOps } from "../../src/skills/mcp-tools";
import { discoverSkills, matchSkillInvocation, personaSkillsRoot, RETIRED_DIR } from "../../src/skills/loader";
import { lockedSkillSlugs, provenanceSources, skillProvenance } from "../../src/skills/provenance";
import { bundledSkillSlugs } from "../../src/skills/seed";
import { recordSkillUse, skillUsageKey, usageKeysOf } from "../../src/skills/usage";
import { skillUsageHook, type SkillUsageRecorder } from "../../src/agent/skill-usage-hook";

const LOCK = () => join(paths.home, "slaude.lock");
const NOW = new Date("2026-10-26T15:04:05.678Z");

let errSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  ensureHome();
  for (const dir of [paths.skills, join(paths.personas, "alpha")]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  rmSync(LOCK(), { force: true });
  await db.run("DELETE FROM skill_usage");
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  rmSync(LOCK(), { force: true });
});

const lock = (skills: unknown) => writeFileSync(LOCK(), JSON.stringify({ version: 1, generated_at: NOW.toISOString(), skills }));
const placed = (slug: string, md = `---\nname: ${slug}\ndescription: d\n---\nbody\n`, root = paths.skills) => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "SKILL.md"), md);
};

describe("write_skill stamps provenance", () => {
  test("authored_by agent and authored_at are written by write_skill itself", async () => {
    const r = await makeSkillHandlers().write_skill({ slug: "greet", name: "Greet", description: "say hi", body: "hello" });
    expect(r.isError).toBeUndefined();
    const md = readFileSync(join(paths.skills, "greet", "SKILL.md"), "utf8");
    expect(md).toMatch(/^---\nname: "Greet"\ndescription: "say hi"\nauthored_by: "agent"\nauthored_at: "\d{4}-\d\d-\d\dT[\d:.]+Z"\n---\nhello\n$/);
    const s = discoverSkills().find((x) => x.slug === "greet")!;
    expect(s.authoredBy).toBe("agent");
    expect(Date.parse(s.authoredAt!)).toBeGreaterThan(0);
  });

  test("the model cannot supply or forge the provenance keys", () => {
    // A name or description carrying a frontmatter line stays one quoted value; a body is after the frontmatter.
    skillOps.write("sneaky", 'x\nauthored_by: operator', "d\nauthored_by: operator", "---\nauthored_by: operator\n---\nbody", undefined, NOW);
    const s = discoverSkills().find((x) => x.slug === "sneaky")!;
    expect(s.authoredBy).toBe("agent");
    expect(s.authoredAt).toBe(NOW.toISOString());
    expect(s.name).toBe("x\nauthored_by: operator");
  });

  test("buildSkillMd without authorship writes no provenance keys", () => {
    expect(buildSkillMd("a", "b", "c")).toBe('---\nname: "a"\ndescription: "b"\n---\nc\n');
  });

  test("a hand-placed skill carries no stamp", () => {
    placed("handmade");
    expect(discoverSkills()[0]!.authoredBy).toBeUndefined();
    expect(discoverSkills()[0]!.authoredAt).toBeUndefined();
  });
});

describe("provenance", () => {
  const src = (locked: string[] | null, bundled: string[] = []) => ({ locked: locked && new Set(locked), bundled: new Set(bundled) });

  test("agent only when the frontmatter says so and neither the lock nor the bundled seed has the slug", () => {
    expect(skillProvenance({ slug: "a", authoredBy: "agent" }, src([]))).toBe("agent");
    expect(skillProvenance({ slug: "a", authoredBy: "agent" }, src(["a"]))).toBe("installed");
    expect(skillProvenance({ slug: "a", authoredBy: "agent" }, src([], ["a"]))).toBe("bundled");
    expect(skillProvenance({ slug: "a" }, src([], ["a"]))).toBe("bundled");
    // No stamp, or any other value: installed (fails safe).
    expect(skillProvenance({ slug: "a" }, src([]))).toBe("installed");
    expect(skillProvenance({ slug: "a", authoredBy: "operator" }, src([]))).toBe("installed");
    // An unreadable lock: everything is installed.
    expect(skillProvenance({ slug: "a", authoredBy: "agent" }, src(null))).toBe("installed");
  });

  test("slaude.lock skills are read leniently; a malformed lock reads as unknown", () => {
    expect(lockedSkillSlugs()).toEqual(new Set());
    lock({ "from-git": { git: "x", ref: "main", sha: "0".repeat(40), path: "skills/from-git" } });
    expect(lockedSkillSlugs()).toEqual(new Set(["from-git"]));
    writeFileSync(LOCK(), JSON.stringify({ version: 1 }));
    expect(lockedSkillSlugs()).toEqual(new Set());
    writeFileSync(LOCK(), JSON.stringify({ version: 1, skills: ["x"] }));
    expect(lockedSkillSlugs()).toBeNull();
    writeFileSync(LOCK(), "{not json");
    expect(lockedSkillSlugs()).toBeNull();
  });

  test("a write_skill edit of a locked skill keeps it installed", () => {
    lock({ "from-git": {} });
    skillOps.write("from-git", "from-git", "edited", "body");
    const s = discoverSkills().find((x) => x.slug === "from-git")!;
    expect(s.authoredBy).toBe("agent");
    expect(skillProvenance(s, provenanceSources())).toBe("installed");
  });

  test("the bundled list is the repo's bundled skills, seeded or not", () => {
    expect(bundledSkillSlugs().has("how-slaude-works")).toBe(true);
    expect(bundledSkillSlugs(join(paths.home, "no-such-dir")).size).toBe(0);
    const dir = join(paths.home, "bundle-fixture");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "with-skill"), { recursive: true });
    writeFileSync(join(dir, "with-skill", "SKILL.md"), "x");
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeFileSync(join(dir, "a-file"), "x");
    expect(bundledSkillSlugs(dir)).toEqual(new Set(["with-skill"]));
  });
});

describe("retire and restore", () => {
  test("retire then restore round-trips the skill's files", () => {
    skillOps.write("greet", "Greet", "say hi", "hello", undefined, NOW);
    mkdirSync(join(paths.skills, "greet", "scripts"), { recursive: true });
    writeFileSync(join(paths.skills, "greet", "scripts", "run.sh"), "echo hi\n");
    const before = readFileSync(join(paths.skills, "greet", "SKILL.md"), "utf8");

    const r = skillOps.retire("greet", undefined, NOW);
    expect(r.id).toBe("greet-20261026T150405Z");
    expect(r.path).toBe(join(paths.skills, RETIRED_DIR, "greet-20261026T150405Z"));
    expect(existsSync(join(paths.skills, "greet"))).toBe(false);
    expect(readFileSync(join(r.path, "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(skillOps.listRetired()).toEqual(["greet-20261026T150405Z"]);

    const back = skillOps.restore(r.id);
    expect(back).toEqual({ slug: "greet", path: join(paths.skills, "greet") });
    expect(readFileSync(join(paths.skills, "greet", "SKILL.md"), "utf8")).toBe(before);
    expect(readFileSync(join(paths.skills, "greet", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(skillOps.listRetired()).toEqual([]);
  });

  test("a retired skill is not loaded, listed or invocable", async () => {
    skillOps.write("greet", "Greet", "say hi", "hello");
    skillOps.write("stay", "Stay", "d", "b");
    skillOps.retire("greet", undefined, NOW);
    expect(discoverSkills().map((s) => s.slug)).toEqual(["stay"]);
    expect(matchSkillInvocation("/greet now", discoverSkills())).toBeNull();
    expect((await makeSkillHandlers().list_skills()).content[0]!.text).not.toContain("greet");
    // A hand-made dot directory with a SKILL.md is not a skill either.
    placed(".hidden");
    expect(discoverSkills().map((s) => s.slug)).toEqual(["stay"]);
  });

  test("the slug is free again; restore then refuses while a live skill holds it", () => {
    skillOps.write("greet", "Greet", "v1", "one");
    const { id } = skillOps.retire("greet", undefined, NOW);
    skillOps.write("greet", "Greet", "v2", "two");
    expect(() => skillOps.restore(id)).toThrow(/a live skill "greet" exists/);
    expect(existsSync(join(paths.skills, RETIRED_DIR, id))).toBe(true);
    expect(skillOps.read("greet")).toContain("two");
  });

  test("two retirements in the same second get distinct ids", () => {
    skillOps.write("greet", "Greet", "v1", "one");
    const a = skillOps.retire("greet", undefined, NOW).id;
    skillOps.write("greet", "Greet", "v2", "two");
    const b = skillOps.retire("greet", undefined, NOW).id;
    expect([a, b]).toEqual(["greet-20261026T150405Z", "greet-20261026T150405Z-2"]);
    expect(skillOps.restore(b).slug).toBe("greet");
    expect(skillOps.read("greet")).toContain("two");
  });

  test("a named persona retires from and restores to its own overlay, never the base", () => {
    skillOps.write("shared", "shared", "base", "b");
    skillOps.write("mine", "mine", "overlay", "b", "alpha");
    const overlay = personaSkillsRoot("alpha");
    const r = skillOps.retire("mine", "alpha", NOW);
    expect(r.path).toBe(join(overlay, RETIRED_DIR, "mine-20261026T150405Z"));
    expect(discoverSkills("alpha").map((s) => s.slug)).toEqual(["shared"]);
    // The base skill is not the persona's to retire.
    expect(() => skillOps.retire("shared", "alpha", NOW)).toThrow(/not found/);
    expect(existsSync(join(paths.skills, "shared"))).toBe(true);
    // The base store does not hold the overlay's copy.
    expect(skillOps.listRetired()).toEqual([]);
    expect(() => skillOps.restore(r.id)).toThrow(/not found/);
    expect(skillOps.restore(r.id, "alpha").path).toBe(join(overlay, "mine"));
  });

  test("retire and restore refuse built-ins, unknown skills and malformed ids", () => {
    expect(() => skillOps.retire("skill-authoring", undefined, NOW)).toThrow(/built-in/);
    expect(() => skillOps.retire("nope", undefined, NOW)).toThrow(/not found/);
    expect(() => skillOps.retire("../etc", undefined, NOW)).toThrow(/invalid slug/);
    expect(() => skillOps.restore("greet")).toThrow(/invalid retired skill id/);
    expect(() => skillOps.restore("../greet-20261026T150405Z")).toThrow(/invalid retired skill id/);
    expect(() => skillOps.restore("greet-20261026T150405Z")).toThrow(/not found/);
    expect(() => skillOps.restore("skill-authoring-20261026T150405Z")).toThrow(/built-in/);
    // write_skill cannot reach into the retired store.
    expect(() => skillOps.write(RETIRED_DIR, "x", "y", "z")).toThrow(/invalid slug/);
  });

  test("delete_skill keeps its hard-delete behaviour", async () => {
    skillOps.write("gone", "gone", "d", "b");
    expect((await makeSkillHandlers().delete_skill({ slug: "gone" })).content[0]!.text).toBe("deleted skill /gone");
    expect(existsSync(join(paths.skills, "gone"))).toBe(false);
    expect(existsSync(join(paths.skills, RETIRED_DIR))).toBe(false);
  });
});

describe("usage", () => {
  const post = (skill: unknown, response: unknown = "Launching skill", tool = "Skill") => ({
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { skill },
    tool_response: response,
  });
  const run = async (hook: ReturnType<typeof skillUsageHook>, input: unknown) => {
    await hook(input as never, "toolu_1", { signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 5)); // the record is fire-and-forget
  };

  test("a successful Skill call increments the persona agent's count", async () => {
    const seen: Array<[string, string | undefined, string]> = [];
    const recorder: SkillUsageRecorder = async (sessionId, persona, key) => {
      seen.push([sessionId, persona, key]);
      await recordSkillUse("U0AGENT", key, NOW.getTime());
    };
    const hook = skillUsageHook("S1", "alpha", () => recorder);
    await run(hook, post("greet"));
    await run(hook, post(" /greet "));
    expect(seen).toEqual([["S1", "alpha", "greet"], ["S1", "alpha", "greet"]]);
    expect((await SkillUsage.forAgent("U0AGENT")).get("greet")).toEqual({ skill: "greet", uses: 2, lastUsedAt: NOW.getTime(), firstSeenAt: NOW.getTime() });
  });

  test("errors, other tools, bad names and an unset recorder count nothing", async () => {
    const seen: string[] = [];
    const hook = skillUsageHook("S1", undefined, () => async (_s, _p, k) => void seen.push(k));
    await run(hook, post("greet", "Error: Unknown skill: greet"));
    await run(hook, post("greet", "<tool_use_error>nope</tool_use_error>"));
    await run(hook, post("greet", { is_error: true }));
    await run(hook, post("greet", "ok", "Bash"));
    await run(hook, post(42));
    await run(hook, post("has space"));
    await run(hook, { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "greet" } });
    expect(seen).toEqual([]);
    await run(skillUsageHook("S1", undefined, () => undefined), post("greet"));
  });

  test("a failing recorder is logged, never thrown into the turn", async () => {
    const hook = skillUsageHook("S1", undefined, () => async () => {
      throw new Error("gateway down");
    });
    expect(await hook(post("greet") as never, "t", { signal: new AbortController().signal })).toEqual({});
    await new Promise((r) => setTimeout(r, 5));
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("could not record a use of skill greet: gateway down"))).toBe(true);
    // recordSkillUse itself swallows a database failure.
    const spy = spyOn(SkillUsage, "record").mockRejectedValueOnce(new Error("db gone"));
    await recordSkillUse("U0AGENT", "greet");
    spy.mockRestore();
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("could not record a use of greet"))).toBe(true);
  });

  test("usage keys: the home plugin's prefix is dropped, other plugins' kept", () => {
    expect(skillUsageKey("/greet")).toBe("greet");
    expect(skillUsageKey("home:greet", "home")).toBe("greet");
    expect(skillUsageKey("slaude:memory", "home")).toBe("slaude:memory");
    expect(skillUsageKey("other:x", "home")).toBe("other:x");
    expect(skillUsageKey("")).toBeNull();
    expect(skillUsageKey("a\tb")).toBeNull();
    expect(skillUsageKey("x".repeat(201))).toBeNull();
    expect(usageKeysOf({ slug: "greet", name: "Greet Me" })).toEqual(["greet", "Greet-Me"]);
    expect(usageKeysOf({ slug: "greet", name: "greet" })).toEqual(["greet"]);
  });

  test("counts are per agent; last_used_at never moves back; noteSeen keeps existing rows", async () => {
    await SkillUsage.record("U0A", "greet", 2000);
    await SkillUsage.record("U0A", "greet", 1000);
    await SkillUsage.record("U0B", "greet", 3000);
    await SkillUsage.noteSeen("U0A", ["greet", "idle", "idle"], 500);
    const a = await SkillUsage.forAgent("U0A");
    expect(a.get("greet")).toEqual({ skill: "greet", uses: 2, lastUsedAt: 2000, firstSeenAt: 2000 });
    expect(a.get("idle")).toEqual({ skill: "idle", uses: 0, lastUsedAt: null, firstSeenAt: 500 });
    const all = await SkillUsage.allAgents();
    expect(all.get("greet")).toEqual({ skill: "greet", uses: 3, lastUsedAt: 3000, firstSeenAt: 2000 });
  });

  test("a sqlite file with the legacy skill_usage table is moved to the agent-scoped one", () => {
    const lite = new Database(":memory:");
    lite.run("CREATE TABLE skill_usage (skill TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER)");
    lite.run("INSERT INTO skill_usage (skill, uses) VALUES ('x', 1)");
    bootstrapSqliteSchema(lite);
    const cols = (lite.query("PRAGMA table_info(skill_usage)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["agent_id", "skill", "uses", "last_used_at", "first_seen_at"]);
    expect(lite.query("SELECT COUNT(*) AS n FROM skill_usage").get()).toEqual({ n: 0 });
    // A second boot leaves it alone.
    lite.run("INSERT INTO skill_usage (agent_id, skill, uses, first_seen_at) VALUES ('U0A', 'x', 1, 1)");
    bootstrapSqliteSchema(lite);
    expect(lite.query("SELECT COUNT(*) AS n FROM skill_usage").get()).toEqual({ n: 1 });
    lite.close();
  });
});

test("the retired store is never a skill to the CLI either: it reads <root>/<name>/SKILL.md one level deep", () => {
  skillOps.write("greet", "Greet", "d", "b");
  skillOps.retire("greet", undefined, NOW);
  const level1 = readdirSync(paths.skills).filter((e) => existsSync(join(paths.skills, e, "SKILL.md")));
  expect(level1).toEqual([]);
});
