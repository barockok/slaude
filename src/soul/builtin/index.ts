import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import pkg from "../../../package.json";

/**
 * The built-in `slaude` plugin: skills shipped with slaude itself, mounted into
 * every session next to the $SLAUDE_HOME plugin. Read-only by convention —
 * nothing in slaude writes here; it ships via the src/ copy and is located by
 * this module's own directory, never $SLAUDE_HOME or cwd.
 */
export const BUILTIN_PLUGIN_DIR: string = join(import.meta.dir);

/** The plugin name from .claude-plugin/plugin.json; skills are `slaude:<name>`. */
const PLUGIN_NAME = "slaude";

export interface BuiltinSkill {
  /** Bare name, e.g. "skill-authoring" */
  name: string;
  /** "slaude:<name>" — what the Skill tool is called with */
  qualified: string;
  description: string;
  /** One line, shown in the core prompt's skill index */
  trigger: string;
  /** Full tool names this skill must be loaded before */
  governs: string[];
  /** package.json version, substituted for {{SLAUDE_VERSION}} */
  version: string;
  /** Markdown body (without frontmatter) */
  body: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseBuiltin(dirName: string, raw: string): BuiltinSkill {
  const where = `built-in skill ${dirName}/SKILL.md`;
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error(`${where}: no frontmatter`);
  const fm = parseYaml((m[1] ?? "").split("{{SLAUDE_VERSION}}").join(pkg.version)) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = fm?.[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`${where}: frontmatter \`${k}\` must be a non-empty string`);
    return v;
  };
  const name = str("name");
  if (name !== dirName) throw new Error(`${where}: name \`${name}\` does not match its directory`);
  const trigger = str("trigger");
  if (trigger.includes("\n")) throw new Error(`${where}: trigger must be one line`);
  const governs = fm.governs ?? [];
  if (!Array.isArray(governs) || !governs.every((g) => typeof g === "string")) {
    throw new Error(`${where}: governs must be a list of tool names`);
  }
  return {
    name,
    qualified: `${PLUGIN_NAME}:${name}`,
    description: str("description"),
    trigger,
    governs,
    version: str("version"),
    body: m[2] ?? "",
  };
}

let cache: BuiltinSkill[] | null = null;

/** Every built-in skill, sorted by name. Parsed once per process. */
export function listBuiltinSkills(): BuiltinSkill[] {
  if (cache) return cache;
  const root = join(BUILTIN_PLUGIN_DIR, "skills");
  const out: BuiltinSkill[] = [];
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(root, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      out.push(parseBuiltin(entry.name, readFileSync(file, "utf8")));
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  cache = out;
  return out;
}

/** The built-in skill that must be loaded before `tool`, or null. */
export function builtinGoverning(tool: string): BuiltinSkill | null {
  return listBuiltinSkills().find((s) => s.governs.includes(tool)) ?? null;
}

/** True when `slug` is a built-in skill's bare name. */
export function isBuiltinSkillName(slug: string): boolean {
  return listBuiltinSkills().some((s) => s.name === slug);
}

/** The name the CLI gives a local plugin directory: its
 *  .claude-plugin/plugin.json `name`, else the directory's basename. An
 *  unreadable manifest counts as absent (the conservative answer here). */
export function cliPluginName(dir: string): string {
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  if (existsSync(manifest)) {
    try {
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return name;
    } catch {
      // fall through to the basename
    }
  }
  return basename(resolve(dir));
}

/** Plugin directories, other than the built-in one, that the CLI would also
 *  name "slaude". The CLI does not de-duplicate plugins by name and resolves a
 *  skill to the first match, so such a plugin's skills share the `slaude:`
 *  namespace and one named like a built-in would answer for it. */
export function pluginsNamedLikeBuiltin(dirs: string[]): string[] {
  const builtin = resolve(BUILTIN_PLUGIN_DIR);
  return dirs.filter((d) => resolve(d) !== builtin && cliPluginName(d) === PLUGIN_NAME);
}

/** A skill's name as the CLI derives it from frontmatter `name`: every
 *  character outside [a-zA-Z0-9_-] becomes "-". */
export function cliSkillName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** The one refusal text for any attempt to change a built-in skill at runtime. */
export function builtinSkillRefusal(slug: string): string {
  return `\`${slug}\` is a built-in skill and cannot be changed at runtime`;
}

/** The core prompt's skill index; "" when there are no built-ins. */
export function renderSkillIndex(): string {
  const skills = listBuiltinSkills();
  if (skills.length === 0) return "";
  return [
    "## Built-in skills (read-only, shipped with slaude)",
    "Load the named skill with the Skill tool before the matching action; the runtime blocks the action until you do.",
    ...skills.map((s) => `- ${s.trigger} → load \`${s.qualified}\``),
  ].join("\n");
}
