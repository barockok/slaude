import { z } from "zod";

const gitUrl = z
  .string()
  .min(1)
  .describe("git URL using 'github:owner/repo' shorthand or full https/ssh URL");

export const pluginEntry = z.object({
  marketplace: gitUrl,
  plugin: z.string().min(1),
  ref: z.string().min(1),
});
export type PluginEntry = z.infer<typeof pluginEntry>;

/** Vercel-style source: "owner/repo" or "owner/repo/skill-path" or "owner/repo@ref" or "owner/repo/skill-path@ref" */
const sourcePattern = z.string().min(1).regex(
  /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*(@[a-zA-Z0-9_.-]+)?$/,
  { message: "source must be owner/repo[/path][@ref]" },
);

export const skillEntry = z.object({
  git: gitUrl.optional(),
  ref: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  source: sourcePattern.optional(),
}).refine(
  (e) => {
    const hasGit = !!e.git;
    const hasRef = !!e.ref;
    const hasSource = !!e.source;
    const hasSlug = !!e.slug;
    if (hasSource) {
      // source is standalone; must not mix with git/ref
      if (hasGit || hasRef) return false;
      return true;
    }
    if (hasGit !== hasRef) return false;
    if (!hasGit && !hasSlug) return false;
    return true;
  },
  { message: "skill must have source (vercel-style), git+ref (git-backed), or slug (local). Mixed modes are invalid." },
);
export type SkillEntry = z.infer<typeof skillEntry>;

export const knowledgeEntry = z.object({
  label: z.string().min(1),
  git: gitUrl.optional(),
  ref: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).refine(
  (e) => {
    const hasGit = !!e.git;
    const hasRef = !!e.ref;
    return hasGit === hasRef;
  },
  { message: "knowledge must have git+ref (git-backed) or neither (local). Mixed git/ref is invalid." },
);
export type KnowledgeEntry = z.infer<typeof knowledgeEntry>;

export function resolveGitUrl(raw: string): string {
  const m = raw.match(/^github:(.+)$/);
  if (m) return `https://github.com/${m[1]}.git`;
  return raw;
}

/** Parse a Vercel-style source string into its components.
 *  "owner/repo" → { git: "github:owner/repo", ref: "main" }
 *  "owner/repo/path" → { git: "github:owner/repo", ref: "main", path: "path" }
 *  "owner/repo@ref" → { git: "github:owner/repo", ref: "ref" }
 *  "owner/repo/path@ref" → { git: "github:owner/repo", ref: "ref", path: "path" }
 */
export function resolveSkillSource(source: string): { git: string; ref: string; path?: string } {
  const atIndex = source.lastIndexOf("@");
  const ref = atIndex > 0 ? source.slice(atIndex + 1) : "main";
  const withoutRef = atIndex > 0 ? source.slice(0, atIndex) : source;
  const parts = withoutRef.split("/");
  if (parts.length < 2) {
    throw new Error(`invalid source "${source}": must be owner/repo[/path][@ref]`);
  }
  const owner = parts[0];
  const repo = parts[1];
  const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  return { git: `github:${owner}/${repo}`, ref, ...(path ? { path } : {}) };
}

export function resolveSkillSlug(entry: { git?: string; slug?: string; source?: string }): string {
  if (entry.slug) return entry.slug;
  if (entry.source) {
    const resolved = resolveSkillSource(entry.source);
    return resolved.path
      ? resolved.path.split("/").pop()!.toLowerCase()
      : resolved.git.split("/").pop()!.replace(/\.git$/, "").toLowerCase();
  }
  if (entry.git) {
    const last = entry.git.split("/").pop() ?? "";
    return last.replace(/\.git$/, "").toLowerCase();
  }
  throw new Error("cannot resolve slug: entry has neither git, source, nor slug");
}

export const slaudeSkillsTarget = z.object({
  git: gitUrl,
  ref: z.string().min(1),
});
export type SlaudeSkillsTarget = z.infer<typeof slaudeSkillsTarget>;

export const slaudeKnowledgeTarget = z.object({
  label: z.string().min(1),
  git: gitUrl,
  ref: z.string().min(1),
});
export type SlaudeKnowledgeTarget = z.infer<typeof slaudeKnowledgeTarget>;

export const manifestSchema = z.object({
  plugins: z.array(pluginEntry).default([]),
  skills: z.array(skillEntry).default([]),
  knowledge: z.array(knowledgeEntry).default([]),
  slaude_skills: slaudeSkillsTarget.optional(),
  slaude_knowledge: slaudeKnowledgeTarget.optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

// --- Lockfile ---

const marketplacePluginLock = z.object({
  version: z.string(),
  subdir: z.string(),
});
const marketplaceEntryLock = z.object({
  sha: z.string().length(40),
  plugins: z.record(z.string(), marketplacePluginLock),
});
const skillLock = z.object({
  git: z.string(),
  ref: z.string(),
  sha: z.string().length(40),
  path: z.string().optional(),
});
const knowledgeLock = z.object({
  git: z.string(),
  ref: z.string(),
  sha: z.string().length(40),
  path: z.string().optional(),
});

const slaudeSkillsLock = z.object({
  git: z.string(),
  ref: z.string(),
  sha: z.string().length(40),
});

const slaudeKnowledgeLock = z.object({
  label: z.string().min(1),
  git: z.string(),
  ref: z.string(),
  raw_sha: z.string().length(40).optional(),
  wiki_sha: z.string().length(40).optional(),
});

export const lockfileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  marketplaces: z.record(z.string(), marketplaceEntryLock).default({}),
  skills: z.record(z.string(), skillLock).default({}),
  knowledge: z.record(z.string(), knowledgeLock).default({}),
  slaude_skills: slaudeSkillsLock.optional(),
  slaude_knowledge: slaudeKnowledgeLock.optional(),
});
export type Lockfile = z.infer<typeof lockfileSchema>;
