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
};

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

/** Discover skills from $SLAUDE_HOME/skills/<slug>/SKILL.md */
export function discoverSkills(): Skill[] {
  const root = paths.skills;
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
    });
  }
  return out;
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
