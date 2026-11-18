import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { cliPluginName } from "../../src/soul/builtin";
import { globalSkillsRoot, personaSkillsRoot } from "../../src/skills/loader";
import { homePluginDirFor } from "../../src/skills/persona-plugin";

const tmpBase = mkdtempSync(join(tmpdir(), "slaude-persona-plugin-"));
const stamp = Date.now().toString(36);
const persona = `pp-${stamp}`;
const shared = `pp-shared-${stamp}`;
const shadowed = `pp-shadow-${stamp}`;
const own = `pp-own-${stamp}`;
let prevTmp: string | undefined;

const writeSkill = (root: string, slug: string, body: string): void => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: d\n---\n${body}\n`);
};

beforeAll(() => {
  prevTmp = process.env.SLAUDE_PLUGIN_TMP;
  process.env.SLAUDE_PLUGIN_TMP = tmpBase;
  writeSkill(globalSkillsRoot(), shared, "global shared");
  writeSkill(globalSkillsRoot(), shadowed, "global version");
});

afterAll(() => {
  if (prevTmp === undefined) delete process.env.SLAUDE_PLUGIN_TMP;
  else process.env.SLAUDE_PLUGIN_TMP = prevTmp;
  rmSync(tmpBase, { recursive: true, force: true });
  rmSync(join(globalSkillsRoot(), shared), { recursive: true, force: true });
  rmSync(join(globalSkillsRoot(), shadowed), { recursive: true, force: true });
  rmSync(join(paths.personas, persona), { recursive: true, force: true });
});

describe("the home plugin for a persona", () => {
  test("the default persona, no persona and a persona with no overlay skills mount $SLAUDE_HOME as before", () => {
    expect(homePluginDirFor(undefined)).toBeNull();
    expect(homePluginDirFor("default")).toBeNull();
    expect(homePluginDirFor(persona)).toBeNull(); // no overlay yet
  });

  test("a persona with overlay skills gets a plugin holding the shared skills and its own, the overlay winning", () => {
    writeSkill(personaSkillsRoot(persona), own, "persona only");
    writeSkill(personaSkillsRoot(persona), shadowed, "persona version");
    const dir = homePluginDirFor(persona)!;
    expect(dir).not.toBeNull();
    // Same plugin name as the home plugin, so skill names, the Skill gate and usage tracking are unchanged.
    expect(cliPluginName(dir)).toBe(cliPluginName(paths.home));
    const skills = join(dir, "skills");
    expect(readdirSync(skills)).toEqual(expect.arrayContaining([shared, shadowed, own]));
    expect(readFileSync(join(skills, own, "SKILL.md"), "utf8")).toContain("persona only");
    expect(readFileSync(join(skills, shared, "SKILL.md"), "utf8")).toContain("global shared");
    expect(readFileSync(join(skills, shadowed, "SKILL.md"), "utf8")).toContain("persona version");
    expect(lstatSync(join(skills, own)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(skills, own))).toBe(join(personaSkillsRoot(persona), own));
  });

  test("dot entries (the retired store) are not skills", () => {
    mkdirSync(join(personaSkillsRoot(persona), ".retired", "old"), { recursive: true });
    writeFileSync(join(personaSkillsRoot(persona), ".retired", "old", "SKILL.md"), "---\nname: old\n---\nx\n");
    const dir = homePluginDirFor(persona)!;
    expect(readdirSync(join(dir, "skills"))).not.toContain(".retired");
  });

  test("the same inputs give the same directory, a change gives a new one, and a stale one is removed", () => {
    const a = homePluginDirFor(persona)!;
    expect(homePluginDirFor(persona)).toBe(a);
    writeSkill(personaSkillsRoot(persona), `${own}-2`, "another");
    const b = homePluginDirFor(persona)!;
    expect(b).not.toBe(a);
    expect(readdirSync(join(b, "skills"))).toContain(`${own}-2`);
    // Make the first look a day and a half old: the next build removes it, and never the current one.
    const old = new Date(Date.now() - 36 * 3600 * 1000);
    utimesSync(a, old, old);
    writeSkill(personaSkillsRoot(persona), `${own}-3`, "third");
    const c = homePluginDirFor(persona)!;
    expect(existsSync(a)).toBe(false);
    expect(existsSync(c)).toBe(true);
  });

  test("a build that cannot be written falls back to the plain home plugin", () => {
    const blocker = join(tmpBase, "blocked");
    writeFileSync(blocker, "a file where the directory should be");
    process.env.SLAUDE_PLUGIN_TMP = blocker;
    try {
      writeSkill(personaSkillsRoot(persona), `${own}-4`, "forces a rebuild");
      expect(homePluginDirFor(persona)).toBeNull();
    } finally {
      process.env.SLAUDE_PLUGIN_TMP = tmpBase;
    }
  });
});
