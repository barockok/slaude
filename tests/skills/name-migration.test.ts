import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { personaSkillsRoot } from "../../src/skills/loader";
import { normaliseSkillNames } from "../../src/skills/name-migration";
import type { ProvenanceSources } from "../../src/skills/provenance";

const SRC: ProvenanceSources = { locked: new Set(["locked-one"]), bundled: new Set(["bundled-one"]) };
const AT = "2026-01-02T03:04:05.000Z";

beforeEach(() => {
  ensureHome();
  for (const d of [paths.skills, paths.personas]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

const md = (name: string, by: string | null = "agent") =>
  `---\nname: ${JSON.stringify(name)}\ndescription: "does a thing"\n${by ? `authored_by: ${JSON.stringify(by)}\nauthored_at: "${AT}"\n` : ""}---\nbody text\n`;
const put = (root: string, slug: string, text: string) => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "SKILL.md"), text);
};
const read = (root: string, slug: string) => readFileSync(join(root, slug, "SKILL.md"), "utf8");

describe("normaliseSkillNames", () => {
  test("an agent-written skill with a title as its name is renamed to its slug and keeps the title, body and time", () => {
    put(paths.skills, "clone-repo", md("Clone a repo by name"));
    expect(normaliseSkillNames({ sources: SRC })).toEqual(["global/clone-repo"]);
    const text = read(paths.skills, "clone-repo");
    expect(text).toContain('name: "clone-repo"');
    expect(text).toContain('title: "Clone a repo by name"');
    expect(text).toContain(`authored_at: "${AT}"`);
    expect(text).toContain("body text");
  });

  test("a skill already named by its slug is left byte for byte alone", () => {
    const original = md("plain");
    put(paths.skills, "plain", original);
    expect(normaliseSkillNames({ sources: SRC })).toEqual([]);
    expect(read(paths.skills, "plain")).toBe(original);
  });

  test("skills the agent did not write are left alone, and so are locked and bundled slugs even with the agent stamp", () => {
    const operator = md("Operator Title", null);
    put(paths.skills, "operator-skill", operator);
    const locked = md("Locked Title");
    put(paths.skills, "locked-one", locked);
    const bundled = md("Bundled Title");
    put(paths.skills, "bundled-one", bundled);
    expect(normaliseSkillNames({ sources: SRC })).toEqual([]);
    expect(read(paths.skills, "operator-skill")).toBe(operator);
    expect(read(paths.skills, "locked-one")).toBe(locked);
    expect(read(paths.skills, "bundled-one")).toBe(bundled);
  });

  test("running it twice changes nothing the second time", () => {
    put(paths.skills, "clone-repo", md("Clone a repo by name"));
    expect(normaliseSkillNames({ sources: SRC })).toHaveLength(1);
    const after = read(paths.skills, "clone-repo");
    expect(normaliseSkillNames({ sources: SRC })).toEqual([]);
    expect(read(paths.skills, "clone-repo")).toBe(after);
  });

  test("a persona's own overlay is migrated under its scope, and the shared base is not counted again for it", () => {
    put(paths.skills, "shared-one", md("Shared Title"));
    put(personaSkillsRoot("sam"), "own-one", md("Own Title"));
    const done = normaliseSkillNames({ sources: SRC, personas: ["sam"] }).sort();
    expect(done).toEqual(["global/shared-one", "sam/own-one"]);
    expect(read(personaSkillsRoot("sam"), "own-one")).toContain('name: "own-one"');
  });

  test("a title that would collide with a built-in's name is not allowed to block the rest", () => {
    put(paths.skills, "good-one", md("Good Title"));
    put(paths.skills, "bad-one", md("skill-authoring")); // sanitises to a built-in's name: write refuses it
    const done = normaliseSkillNames({ sources: SRC });
    expect(done).toContain("global/good-one");
    expect(done).not.toContain("global/bad-one");
  });
});

describe("gateway start-up", () => {
  test("the gateway runs the migration, after the object-store mirror is up when there is one", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/gateway/core/gateway.ts"), "utf8");
    expect(src).toContain("normaliseSkillNames()");
    const mirror = src.indexOf("void startSkillMirror(");
    const firstCall = src.indexOf("renameSkillsBySlug()");
    expect(mirror).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(-1);
  });
});
