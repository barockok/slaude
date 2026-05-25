import { execFileSync } from "node:child_process";
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

/** Detect if cwd is inside a git worktree. Returns worktree root path or null. */
export function detectWorktree(): string | null {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (gitDir === gitCommonDir) return null; // not a worktree
    const worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    return worktreeRoot || null;
  } catch {
    return null;
  }
}

/** Discover skills from $SLAUDE_HOME/skills/<slug>/SKILL.md and optionally from <worktree>/.claude/skills/<slug>/SKILL.md */
export function discoverSkills(): Skill[] {
  const roots = [paths.skills];
  const worktreeRoot = detectWorktree();
  if (worktreeRoot) {
    roots.push(join(worktreeRoot, ".claude", "skills"));
  }

  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (seen.has(entry)) continue;
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      const skillPath = join(dir, "SKILL.md");
      const parsed = parseSkillFile(skillPath);
      if (!parsed) continue;
      seen.add(entry);
      out.push({
        slug: entry,
        name: parsed.name || entry,
        description: parsed.description,
        body: parsed.body,
        dir,
      });
    }
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
  const env: Record<string, string> = {
    SLAUDE_SKILL_DIR: skill.dir,
    SLAUDE_SESSION_ID: sessionId,
    SLAUDE_SKILL_ARGS: args,
  };
  const worktreeRoot = detectWorktree();
  if (worktreeRoot) {
    env.SLAUDE_WORKTREE_DIR = worktreeRoot;
  }
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
