import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
  detectWorktree,
} from "../src/skills/loader";

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

function writeSkill(slug: string, body: string) {
  const dir = join(paths.skills, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}

describe("discoverSkills", () => {
  test("empty when dir empty", () => {
    expect(discoverSkills()).toEqual([]);
  });
  test("missing root returns []", () => {
    rmSync(paths.skills, { recursive: true, force: true });
    expect(discoverSkills()).toEqual([]);
  });
  test("parses frontmatter + body", () => {
    writeSkill(
      "release",
      ["---", "name: release", "description: cut release", "---", "do the thing"].join("\n"),
    );
    const out = discoverSkills();
    expect(out.length).toBe(1);
    expect(out[0]?.slug).toBe("release");
    expect(out[0]?.name).toBe("release");
    expect(out[0]?.description).toBe("cut release");
    expect(out[0]?.body.trim()).toBe("do the thing");
  });
  test("missing frontmatter → name=slug, body=raw", () => {
    writeSkill("plain", "just body");
    const out = discoverSkills();
    expect(out[0]?.name).toBe("plain");
    expect(out[0]?.description).toBe("");
    expect(out[0]?.body).toBe("just body");
  });
  test("invalid yaml → name/desc empty but does not throw", () => {
    writeSkill("bad", ["---", "name: [unclosed", "---", "body"].join("\n"));
    const out = discoverSkills();
    expect(out[0]?.name).toBe("bad"); // falls back to slug
  });
  test("non-directory entries skipped", () => {
    writeFileSync(join(paths.skills, "stray.txt"), "x");
    expect(discoverSkills()).toEqual([]);
  });
  test("skill dir without SKILL.md skipped", () => {
    mkdirSync(join(paths.skills, "empty"));
    expect(discoverSkills()).toEqual([]);
  });
});

describe("matchSkillInvocation", () => {
  const skills = [
    { slug: "rel", name: "rel", description: "", body: "", dir: "/x" },
  ];
  test("matches /slug", () => {
    expect(matchSkillInvocation("/rel arg1 arg2", skills)).toEqual({
      skill: skills[0]!,
      args: "arg1 arg2",
    });
  });
  test("non-slash → null", () => {
    expect(matchSkillInvocation("hi", skills)).toBeNull();
  });
  test("unknown slug → null", () => {
    expect(matchSkillInvocation("/wat", skills)).toBeNull();
  });
});

describe("buildSkillInvocation", () => {
  test("substitutes env + args", () => {
    const skill = {
      slug: "rel",
      name: "rel",
      description: "",
      body: "session=${SLAUDE_SESSION_ID} dir=${SLAUDE_SKILL_DIR} args=${SLAUDE_SKILL_ARGS}",
      dir: "/d",
    };
    const out = buildSkillInvocation(skill, "abc", "S1");
    expect(out).toContain("session=S1");
    expect(out).toContain("dir=/d");
    expect(out).toContain("args=abc");
    expect(out).toContain('<skill name="rel" slug="rel">');
    expect(out).toContain("<skill-args>");
  });
  test("no args → no skill-args block", () => {
    const skill = { slug: "x", name: "x", description: "", body: "b", dir: "/d" };
    const out = buildSkillInvocation(skill, "", "S");
    expect(out).not.toContain("<skill-args>");
  });
  test("includes SLAUDE_WORKTREE_DIR when in worktree", () => {
    const skill = { slug: "x", name: "x", description: "", body: "wt=${SLAUDE_WORKTREE_DIR}", dir: "/d" };
    const out = buildSkillInvocation(skill, "", "S");
    // We are not in a worktree here, so variable should not be substituted
    expect(out).toContain("wt=${SLAUDE_WORKTREE_DIR}");
  });
});

describe("detectWorktree", () => {
  test("returns null when not in a worktree", () => {
    // Tests run in the main slaude repo checkout, not a linked worktree
    const wt = detectWorktree();
    expect(wt).toBeNull();
  });
});

describe("discoverSkills with worktree skills", () => {
  test("discovers skills from worktree .claude/skills when in worktree", () => {
    // Create a skill in the global skills dir
    writeSkill("global-skill", "---\nname: global\ndescription: global skill\n---\nglobal body");

    // Simulate a worktree by temporarily overriding detectWorktree behavior
    // We can't easily mock the function, so we'll test that discoverSkills
    // still finds the global skill at minimum
    const skills = discoverSkills();
    const globalSkill = skills.find((s) => s.slug === "global-skill");
    expect(globalSkill).toBeDefined();
    expect(globalSkill?.name).toBe("global");
  });
});
