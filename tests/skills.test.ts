import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../src/skills/loader";
import { skillOps } from "../src/skills/mcp-tools";

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

// WS-C §4.3.2: provenance while merging, with no change in what is merged.
describe("discoverSkills provenance", () => {
  const overlay = join(paths.personas, "prov-ana", "skills");
  const writeOverlay = (slug: string, body: string) => {
    mkdirSync(join(overlay, slug), { recursive: true });
    writeFileSync(join(overlay, slug, "SKILL.md"), body);
  };
  beforeEach(() => rmSync(join(paths.personas, "prov-ana"), { recursive: true, force: true }));

  test("global skills are 'global'; the default persona sees only those", () => {
    writeSkill("release", "body");
    expect(discoverSkills().map((s) => [s.slug, s.source])).toEqual([["release", "global"]]);
    expect(discoverSkills("default").map((s) => [s.slug, s.source])).toEqual([["release", "global"]]);
  });

  test("a persona's own skill is 'persona', and shadows a global of the same slug", () => {
    writeSkill("release", "global body");
    writeSkill("triage", "global triage");
    writeOverlay("release", "persona body");
    writeOverlay("budget", "persona budget");
    const by = new Map(discoverSkills("prov-ana").map((s) => [s.slug, s]));
    expect(by.get("triage")?.source).toBe("global");
    expect(by.get("release")?.source).toBe("persona");
    expect(by.get("release")?.body).toBe("persona body");
    expect(by.get("budget")?.source).toBe("persona");
    expect(skillOps.list("prov-ana").find((s) => s.slug === "release")?.source).toBe("persona");
  });
});

describe("matchSkillInvocation", () => {
  const skills = [
    { slug: "rel", name: "rel", description: "", body: "", dir: "/x", source: "global" as const },
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
      source: "global" as const,
    };
    const out = buildSkillInvocation(skill, "abc", "S1");
    expect(out).toContain("session=S1");
    expect(out).toContain("dir=/d");
    expect(out).toContain("args=abc");
    expect(out).toContain('<skill name="rel" slug="rel">');
    expect(out).toContain("<skill-args>");
  });
  test("no args → no skill-args block", () => {
    const skill = { slug: "x", name: "x", description: "", body: "b", dir: "/d", source: "global" as const };
    const out = buildSkillInvocation(skill, "", "S");
    expect(out).not.toContain("<skill-args>");
  });
});
