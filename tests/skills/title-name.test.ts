import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { skillHandlers, skillOps } from "../../src/skills/mcp-tools";
import { buildSkillInvocation, discoverSkills, parseSkillText } from "../../src/skills/loader";
import { allowedSkillNames } from "../../src/agent/skill-allow";
import { cliSkillName } from "../../src/soul/builtin";

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

const fileOf = (slug: string) => readFileSync(join(paths.skills, slug, "SKILL.md"), "utf8");

describe("a skill written with a human title is still named by its slug", () => {
  test("frontmatter name is the slug and the title is kept beside it", () => {
    skillOps.write("clone-repo", "Clone a repo by name", "clone it", "body");
    const text = fileOf("clone-repo");
    expect(text).toContain('name: "clone-repo"');
    expect(text).toContain('title: "Clone a repo by name"');
    const s = discoverSkills().find((x) => x.slug === "clone-repo")!;
    expect(s.name).toBe("clone-repo");
    expect(s.title).toBe("Clone a repo by name");
  });

  test("a name equal to the slug writes no title", () => {
    skillOps.write("plain", "plain", "d", "body");
    expect(fileOf("plain")).not.toContain("title:");
    expect(discoverSkills().find((x) => x.slug === "plain")!.title).toBeUndefined();
  });

  test("a title with quotes, a colon and a newline round-trips", () => {
    const awkward = 'Say "hi": now\nand then';
    skillOps.write("awkward", awkward, "d", "body");
    expect(parseSkillText(fileOf("awkward")).title).toBe(awkward);
  });

  test("list_skills and the inlined invocation still show the human title", async () => {
    skillOps.write("clone-repo", "Clone a repo by name", "clone it", "body");
    const listed = await skillHandlers.list_skills();
    expect(listed.content[0]?.text).toContain("/clone-repo  —  Clone a repo by name: clone it");
    const s = discoverSkills().find((x) => x.slug === "clone-repo")!;
    expect(buildSkillInvocation(s, "", "sess")).toContain('<skill name="Clone a repo by name" slug="clone-repo">');
  });

  test("an agent.yaml list entry by slug allows the skill, and the old title's CLI name still does too", () => {
    skillOps.write("clone-repo", "Clone a repo by name", "clone it", "body");
    const names = allowedSkillNames(["clone-repo"], undefined);
    expect(names).toContain("clone-repo");
    expect(names).toContain(cliSkillName("Clone a repo by name"));
  });
});
