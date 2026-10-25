import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { runtimeBaseline } from "../../src/soul/loader";
import {
  BUILTIN_PLUGIN_DIR,
  builtinGoverning,
  cliPluginName,
  isBuiltinSkillName,
  listBuiltinSkills,
  pluginsNamedLikeBuiltin,
  renderSkillIndex,
} from "../../src/soul/builtin";
import pkg from "../../package.json";

const GOLDEN = join(import.meta.dir, "__golden__");
const golden = (name: string) => readFileSync(join(GOLDEN, `${name}.txt`), "utf8");
/** Goldens hold a token where the (per-run) knowledge dir goes. */
const norm = (s: string) => s.split(paths.knowledge).join("<KNOWLEDGE_ROOT>");

const HEADING = "## Skill evolution (grow over time)";

/**
 * Boundary rule: the section runs from the line "## Skill evolution (grow over
 * time)" up to, not including, the next line starting with "## ", minus the
 * blank line(s) before that heading. It has no trailing newline, so replacing
 * it with an index (also no trailing newline) leaves exactly one blank line
 * before the next heading. The committed file stores it plus one final "\n".
 */
function extractSection(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(HEADING);
  if (start < 0) throw new Error("no Skill evolution heading");
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
  if (end === lines.length) throw new Error("no heading after Skill evolution");
  while (lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n");
}

const sectionFile = golden("skill-evolution-section");
const section = sectionFile.slice(0, -1);

/**
 * The allowed differences from the pre-R baseline:
 *  (a) the Skill evolution section, minus the runtime-check bullet, moves to
 *      the slaude:skill-authoring body;
 *  (b) the skill index replaces the section in the core;
 *  (c) the runtime-check bullet stays in the core (every turn needs it: the
 *      no-op auto-evolve path never loads the skill), as one line directly
 *      after the index list.
 */
const BULLET_IN_SECTION =
  "- Messages wrapped in `<runtime-check ...>` come from the runtime, not a\n  person. They never require a reply.\n";
const BULLET_IN_CORE =
  "- Messages wrapped in `<runtime-check ...>` come from the runtime, not a person. They never require a reply.";
const skillBody = section.split(BULLET_IN_SECTION).join("") + "\n";
const coreBlock = () => `${renderSkillIndex()}\n${BULLET_IN_CORE}`;

describe("built-in skills", () => {
  it("captured section file follows the boundary rule", () => {
    expect(sectionFile.endsWith("\n")).toBe(true);
    expect(section.endsWith("\n")).toBe(false);
    expect(extractSection(golden("baseline-brain"))).toBe(section);
    expect(extractSection(golden("baseline-nobrain"))).toBe(section);
  });

  it("lists skill-authoring with its governed tools", () => {
    const s = listBuiltinSkills();
    expect(s.map((x) => x.qualified)).toEqual(["slaude:memory", "slaude:skill-authoring"]);
    const sa = s.find((x) => x.name === "skill-authoring")!;
    expect(sa.name).toBe("skill-authoring");
    expect(sa.description).toBe("How to create, refine and retire your own skills.");
    expect(sa.trigger).toBe("Before write_skill or delete_skill");
    expect(sa.governs).toEqual(["mcp__slaude_skills__write_skill", "mcp__slaude_skills__delete_skill"]);
    expect(sa.version).toBe(pkg.version);
    expect(builtinGoverning("mcp__slaude_skills__write_skill")?.name).toBe("skill-authoring");
    expect(builtinGoverning("mcp__slaude_skills__delete_skill")?.name).toBe("skill-authoring");
    expect(builtinGoverning("Read")).toBeNull();
    expect(builtinGoverning("mcp__slaude_skills__list_skills")).toBeNull();
    expect(isBuiltinSkillName("skill-authoring")).toBe(true);
    expect(isBuiltinSkillName("slaude:skill-authoring")).toBe(false);
    expect(isBuiltinSkillName("release-notes")).toBe(false);
  });

  it("parses once", () => {
    expect(listBuiltinSkills()[0]).toBe(listBuiltinSkills()[0]);
  });

  it("the SKILL.md file keeps the version placeholder literal", () => {
    const raw = readFileSync(join(BUILTIN_PLUGIN_DIR, "skills", "skill-authoring", "SKILL.md"), "utf8");
    expect(raw).toContain("{{SLAUDE_VERSION}}");
    expect(raw.split("{{SLAUDE_VERSION}}")).toHaveLength(2);
  });

  it("skill body is the pre-R Skill evolution section verbatim, minus the runtime-check bullet", () => {
    const sa = listBuiltinSkills().find((x) => x.name === "skill-authoring")!;
    expect(section.split(BULLET_IN_SECTION)).toHaveLength(2);
    expect(sa.body).toBe(skillBody);
    expect(sa.body).not.toContain("runtime-check");
    expect(sa.body).toContain("${SLAUDE_SKILL_ARGS}");
    expect(sa.body).toContain("${SLAUDE_SKILL_DIR}");
    expect(sa.body).toContain("${SLAUDE_SESSION_ID}");
  });

  it("baseline = pre-R golden with the section replaced by the index and the runtime-check bullet", () => {
    for (const [brain, name] of [[true, "baseline-brain"], [false, "baseline-nobrain"]] as const) {
      const g = golden(name);
      expect(g.split(section)).toHaveLength(2);
      const want = g.split(section).join(coreBlock());
      expect(norm(runtimeBaseline(brain))).toBe(want);
      // exactly one blank line before the next heading
      expect(want).toContain(`${coreBlock()}\n\n## Progress visibility`);
      expect(want).not.toContain(`${coreBlock()}\n\n\n`);
    }
  });

  it("the runtime-check bullet stays in the core prompt", () => {
    for (const brain of [true, false]) {
      expect(runtimeBaseline(brain).split(`\n${BULLET_IN_CORE}\n`)).toHaveLength(2);
    }
  });

  it("index format is exact", () => {
    expect(renderSkillIndex()).toBe(
      "## Built-in skills (read-only, shipped with slaude)\n" +
        "Load the named skill with the Skill tool before the matching action; the runtime blocks the action until you do.\n" +
        "- Before kb_memoize → load `slaude:memory`\n" +
        "- Before write_skill or delete_skill → load `slaude:skill-authoring`",
    );
  });

  it("index lists exactly the built-ins present", () => {
    const dirs = readdirSync(join(BUILTIN_PLUGIN_DIR, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(BUILTIN_PLUGIN_DIR, "skills", d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
    expect(listBuiltinSkills().map((s) => s.name)).toEqual(dirs);
    const bullets = renderSkillIndex().split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(listBuiltinSkills().map((s) => `- ${s.trigger} → load \`${s.qualified}\``));
  });

  it("plugin.json names the plugin slaude", () => {
    const manifest = JSON.parse(readFileSync(join(BUILTIN_PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("slaude");
    for (const s of listBuiltinSkills()) expect(s.qualified).toBe(`${manifest.name}:${s.name}`);
    expect(BUILTIN_PLUGIN_DIR).toBe(join(import.meta.dir, "..", "..", "src", "soul", "builtin"));
  });
});

describe("CLI plugin naming", () => {
  it("names a plugin by its manifest, else by its directory basename", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-name-"));
    try {
      const bare = join(root, "slaude");
      mkdirSync(bare);
      const named = join(root, "slaude-named");
      mkdirSync(join(named, ".claude-plugin"), { recursive: true });
      writeFileSync(join(named, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "slaude" }));
      const renamed = join(root, "other", "slaude");
      mkdirSync(join(renamed, ".claude-plugin"), { recursive: true });
      writeFileSync(join(renamed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "home" }));
      const broken = join(root, "broken", "slaude");
      mkdirSync(join(broken, ".claude-plugin"), { recursive: true });
      writeFileSync(join(broken, ".claude-plugin", "plugin.json"), "{not json");
      const safe = join(root, "data");
      mkdirSync(safe);

      expect(cliPluginName(BUILTIN_PLUGIN_DIR)).toBe("slaude");
      expect(cliPluginName(bare)).toBe("slaude");
      expect(cliPluginName(bare + "/")).toBe("slaude");
      expect(cliPluginName(renamed)).toBe("home");
      expect(cliPluginName(safe)).toBe("data");

      // the built-in itself never counts, however it is spelled
      expect(pluginsNamedLikeBuiltin([BUILTIN_PLUGIN_DIR, BUILTIN_PLUGIN_DIR + "/", safe, renamed])).toEqual([]);
      expect(pluginsNamedLikeBuiltin([safe, bare, named, renamed, broken, BUILTIN_PLUGIN_DIR])).toEqual([bare, named, broken]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
