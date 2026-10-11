import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { paths } from "../config/home";

export type Skill = {
  /** Hyphenated slug, e.g. "release-notes" */
  slug: string;
  /** Frontmatter `name`, defaults to slug */
  name: string;
  /** Frontmatter `description` */
  description: string;
  /** Markdown body (without frontmatter) */
  body: string;
  /** Absolute dir path */
  dir: string;
  /** Which root it came from: the shared base, or the persona's own overlay
   *  (which shadows a base skill of the same slug). */
  source: SkillSource;
};

export type SkillSource = "global" | "persona";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseSkillFile(absPath: string): Pick<Skill, "name" | "description" | "body"> | null {
  if (!existsSync(absPath)) return null;
  const raw = readFileSync(absPath, "utf8");
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return { name: "", description: "", body: raw };
  }
  let fm: Record<string, unknown> = {};
  try {
    fm = (parseYaml(m[1] ?? "") as Record<string, unknown>) ?? {};
  } catch {
    fm = {};
  }
  return {
    name: typeof fm.name === "string" ? fm.name : "",
    description: typeof fm.description === "string" ? fm.description : "",
    body: m[2] ?? "",
  };
}

/**
 * The skills layout is a contract between the gateway and the nodes (WS-C
 * §4.3.1): both mount one $SLAUDE_HOME, the gateway lists and writes skills
 * through these two roots, the runtime bundle names them, and a node's SDK
 * discovers the global root through the plugin mounted at $SLAUDE_HOME (the
 * SDK reads <plugin>/skills/). tests/skills-layout.test.ts fails if either moves.
 */
/** The shared base: $SLAUDE_HOME/skills/ */
export function globalSkillsRoot(): string {
  return paths.skills;
}

/** A named persona's private skills overlay: personas/<name>/skills/ */
export function personaSkillsRoot(personaName: string): string {
  return join(paths.personas, personaName, "skills");
}

/** The skill roots a persona resolves, base first, its overlay last (none for the default persona). */
export function skillRootsFor(personaName?: string): string[] {
  const persona = personaName && personaName !== "default" ? personaName : null;
  return persona ? [globalSkillsRoot(), personaSkillsRoot(persona)] : [globalSkillsRoot()];
}

/** Scan one skills root into Skill[]. Missing root → []. */
function scanSkillsRoot(root: string, source: SkillSource): Skill[] {
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skillPath = join(dir, "SKILL.md");
    const parsed = parseSkillFile(skillPath);
    if (!parsed) continue;
    out.push({
      slug: entry,
      name: parsed.name || entry,
      description: parsed.description,
      body: parsed.body,
      dir,
      source,
    });
  }
  return out;
}

/** Discover skills from the global base ($SLAUDE_HOME/skills/). When a named
 *  persona is given, its private overlay (personas/<name>/skills/) is merged on
 *  top — a persona skill shadows a base skill of the same slug. Default persona
 *  (or no persona) → base only, unchanged. */
export function discoverSkills(personaName?: string): Skill[] {
  const base = scanSkillsRoot(globalSkillsRoot(), "global");
  const persona = personaName && personaName !== "default" ? personaName : null;
  if (!persona) return base;
  const bySlug = new Map<string, Skill>(base.map((s) => [s.slug, s]));
  for (const s of scanSkillsRoot(personaSkillsRoot(persona), "persona")) bySlug.set(s.slug, s);
  return [...bySlug.values()];
}

/** Slack message text → maybe a /skill-name invocation. Returns matching skill + remaining args. */
export function matchSkillInvocation(text: string, skills: Skill[]): { skill: Skill; args: string } | null {
  const m = text.match(/^\s*\/([a-z0-9][a-z0-9-]*)\b\s*(.*)$/i);
  if (!m) return null;
  const slug = (m[1] ?? "").toLowerCase();
  const skill = skills.find((s) => s.slug.toLowerCase() === slug);
  if (!skill) return null;
  return { skill, args: m[2] ?? "" };
}

/** Build the user message that invokes a skill. Mirrors hermes pattern. */
export function buildSkillInvocation(skill: Skill, args: string, sessionId: string): string {
  const env = {
    SLAUDE_SKILL_DIR: skill.dir,
    SLAUDE_SESSION_ID: sessionId,
    SLAUDE_SKILL_ARGS: args,
  };
  let body = skill.body;
  for (const [k, v] of Object.entries(env)) {
    body = body.replaceAll(`\${${k}}`, v);
  }
  return [
    `<skill name="${skill.name}" slug="${skill.slug}">`,
    body.trim(),
    `</skill>`,
    args ? `\n<skill-args>\n${args}\n</skill-args>` : "",
  ].join("\n");
}
