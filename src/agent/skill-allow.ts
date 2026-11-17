import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "../config/home";
import { cliPluginName, cliSkillName, listBuiltinSkills } from "../soul/builtin";
import { discoverSkills, skillFileName } from "../skills/loader";

/**
 * An agent.yaml's `skills` list as the Skill tool reads it. The list names
 * skill slugs; the CLI names a skill after its frontmatter `name`, so both are
 * accepted. Built-in `slaude:*` skills and installed plugins' skills are not
 * subject to the list: built-ins are the runtime's own (a governed tool would
 * otherwise never unblock), and every plugin on a machine belongs to every
 * agent there (`runsOn` decides the machine).
 */
export function allowedSkillNames(allowed: readonly string[], persona: string | undefined): string[] {
  const set = new Set(allowed);
  const names = new Set<string>(allowed);
  for (const s of discoverSkills(persona)) {
    if (set.has(s.slug)) names.add(cliSkillName(s.name || s.slug));
  }
  return [...names];
}

/** The `$SLAUDE_HOME` plugin's namespace: the one prefix the list applies to. */
export const homeSkillNamespace = (): string => cliPluginName(paths.home);

/**
 * Whether the Skill tool may load `name` (trimmed, one leading "/" removed).
 * A listed skill, a built-in, or a qualified name in the namespace of a plugin
 * this session mounted passes. Anything else is refused: a bare name must be
 * listed, and an unknown namespace is not assumed to be a plugin.
 */
export function isSkillAllowed(name: string, allowed: ReadonlySet<string>, mounted: ReadonlySet<string>, home: string = homeSkillNamespace()): boolean {
  if (allowed.has(name)) return true;
  const colon = name.indexOf(":");
  if (colon < 0) return false;
  const ns = name.slice(0, colon);
  const bare = name.slice(colon + 1);
  if (ns === home) return allowed.has(bare);
  if (listBuiltinSkills().some((b) => b.qualified === name)) return true;
  return ns !== "slaude" && mounted.has(ns);
}

function pluginSkillIds(dir: string): string[] {
  const ns = cliPluginName(dir);
  const out: string[] = [];
  const skills = join(dir, "skills");
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills)) {
      if (entry.startsWith(".")) continue;
      const name = skillFileName(join(skills, entry, "SKILL.md"));
      if (name !== null) out.push(`${ns}:${cliSkillName(name || entry)}`);
    }
  }
  const commands = join(dir, "commands");
  if (existsSync(commands)) {
    for (const entry of readdirSync(commands)) {
      if (entry.endsWith(".md")) out.push(`${ns}:${basename(entry, ".md")}`);
    }
  }
  return out;
}

/**
 * The SDK `skills` option for a session with a list: the CLI hides anything
 * not named from the model's listing. Listed home skills in both spellings,
 * every built-in, and everything installed plugins provide (the list does not
 * limit plugins). The hard enforcement is the Skill gate; this keeps the model
 * from being offered what the gate would refuse.
 */
export function sdkSkillsOption(names: readonly string[], pluginDirs: readonly string[]): string[] {
  const home = homeSkillNamespace();
  return [
    ...names,
    ...names.map((n) => `${home}:${n}`),
    ...listBuiltinSkills().map((b) => b.qualified),
    ...pluginDirs.flatMap(pluginSkillIds),
  ];
}
