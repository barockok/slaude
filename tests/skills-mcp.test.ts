import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import {
  buildSkillMd,
  createSkillsMcp,
  resolveSkillDir,
  SKILLS_MCP_NAME,
  skillHandlers,
  skillOps,
} from "../src/skills/mcp-tools";
import { discoverSkills } from "../src/skills/loader";

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

describe("resolveSkillDir", () => {
  test("valid slug returns dir under skills root", () => {
    const dir = resolveSkillDir("release-notes");
    expect(dir).toBe(join(paths.skills, "release-notes"));
  });
  test("uppercase rejected", () => {
    expect(() => resolveSkillDir("Bad")).toThrow(/invalid slug/);
  });
  test("path traversal rejected", () => {
    expect(() => resolveSkillDir("../etc")).toThrow();
    expect(() => resolveSkillDir("foo/bar")).toThrow();
    expect(() => resolveSkillDir(".")).toThrow();
    expect(() => resolveSkillDir("")).toThrow();
  });
  test("leading dash rejected", () => {
    expect(() => resolveSkillDir("-foo")).toThrow(/invalid slug/);
  });
});

describe("buildSkillMd", () => {
  test("emits frontmatter with json-escaped values + trailing newline", () => {
    const out = buildSkillMd("My Skill", 'cuts "the" release', "step 1");
    expect(out).toContain("---\n");
    expect(out).toContain('name: "My Skill"');
    expect(out).toContain('description: "cuts \\"the\\" release"');
    expect(out.endsWith("\n")).toBe(true);
  });
  test("preserves trailing newline if already present", () => {
    const out = buildSkillMd("a", "b", "body\n");
    expect(out.endsWith("body\n")).toBe(true);
    expect(out.endsWith("body\n\n")).toBe(false);
  });
});

describe("skillOps", () => {
  test("list empty when no skills", () => {
    expect(skillOps.list()).toEqual([]);
  });
  test("write creates skill and discoverSkills picks it up (hot-reload)", () => {
    const r = skillOps.write("greet", "Greet", "say hi", "hello ${SLAUDE_SKILL_ARGS}");
    expect(r.created).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    const out = discoverSkills();
    expect(out.length).toBe(1);
    expect(out[0]?.slug).toBe("greet");
    expect(out[0]?.name).toBe("Greet");
    expect(out[0]?.description).toBe("say hi");
  });
  test("second write updates without creating", () => {
    skillOps.write("x", "x", "d1", "body1");
    const r2 = skillOps.write("x", "x", "d2", "body2");
    expect(r2.created).toBe(false);
    const md = readFileSync(r2.path, "utf8");
    expect(md).toContain('description: "d2"');
    expect(md).toContain("body2");
  });
  test("read returns full SKILL.md", () => {
    skillOps.write("r", "r", "desc", "body");
    const md = skillOps.read("r");
    expect(md).toContain('name: "r"');
    expect(md).toContain("body");
  });
  test("read missing throws", () => {
    expect(() => skillOps.read("nope")).toThrow(/not found/);
  });
  test("delete removes dir", () => {
    skillOps.write("rm", "rm", "d", "b");
    skillOps.delete("rm");
    expect(existsSync(join(paths.skills, "rm"))).toBe(false);
  });
  test("delete missing throws", () => {
    expect(() => skillOps.delete("ghost")).toThrow(/not found/);
  });
});

describe("createSkillsMcp", () => {
  test("returns sdk mcp config with expected name", () => {
    const cfg = createSkillsMcp();
    expect(cfg.name).toBe(SKILLS_MCP_NAME);
    expect((cfg as any).type).toBe("sdk");
    expect((cfg as any).instance).toBeDefined();
  });
});

describe("skillHandlers", () => {
  test("list_skills empty", async () => {
    const r = await skillHandlers.list_skills();
    expect(r.content[0]?.text).toBe("(no skills installed)");
    expect(r.isError).toBeUndefined();
  });
  test("list_skills enumerates created skills", async () => {
    skillOps.write("a", "A skill", "do a", "body a");
    skillOps.write("b", "B skill", "", "body b");
    const r = await skillHandlers.list_skills();
    expect(r.content[0]?.text).toContain("/a");
    expect(r.content[0]?.text).toContain("A skill: do a");
    expect(r.content[0]?.text).toContain("/b");
    expect(r.content[0]?.text).toContain("(no description)");
  });
  test("read_skill ok", async () => {
    skillOps.write("r", "R", "desc", "body");
    const r = await skillHandlers.read_skill({ slug: "r" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain('name: "R"');
  });
  test("read_skill missing returns error", async () => {
    const r = await skillHandlers.read_skill({ slug: "ghost" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("not found");
  });
  test("read_skill invalid slug returns error", async () => {
    const r = await skillHandlers.read_skill({ slug: "BAD" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("invalid slug");
  });
  test("write_skill creates then updates", async () => {
    const r1 = await skillHandlers.write_skill({
      slug: "w",
      name: "W",
      description: "d",
      body: "b",
    });
    expect(r1.isError).toBeUndefined();
    expect(r1.content[0]?.text).toContain("created skill /w");
    const r2 = await skillHandlers.write_skill({
      slug: "w",
      name: "W2",
      description: "d2",
      body: "b2",
    });
    expect(r2.content[0]?.text).toContain("updated skill /w");
  });
  test("write_skill bad slug returns error", async () => {
    const r = await skillHandlers.write_skill({
      slug: "../escape",
      name: "x",
      description: "x",
      body: "x",
    });
    expect(r.isError).toBe(true);
  });
  test("delete_skill ok", async () => {
    skillOps.write("d", "d", "d", "b");
    const r = await skillHandlers.delete_skill({ slug: "d" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toBe("deleted skill /d");
  });
  test("delete_skill missing returns error", async () => {
    const r = await skillHandlers.delete_skill({ slug: "ghost" });
    expect(r.isError).toBe(true);
  });
});
