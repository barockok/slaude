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

export const skillEntry = z.object({
  git: gitUrl.optional(),
  ref: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).refine(
  (e) => {
    const hasGit = !!e.git;
    const hasRef = !!e.ref;
    if (hasGit !== hasRef) return false;
    if (!hasGit && !e.slug) return false;
    return true;
  },
  { message: "skill must have git+ref (git-backed) or slug (local). Mixed git/ref or local without slug is invalid." },
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

export function resolveSkillSlug(entry: { git?: string; slug?: string }): string {
  if (entry.slug) return entry.slug;
  if (entry.git) {
    const last = entry.git.split("/").pop() ?? "";
    return last.replace(/\.git$/, "").toLowerCase();
  }
  throw new Error("cannot resolve slug: entry has neither git nor slug");
}

export const slaudeSkillsTarget = z.object({
  git: gitUrl,
  ref: z.string().min(1),
});
export type SlaudeSkillsTarget = z.infer<typeof slaudeSkillsTarget>;

export const manifestSchema = z.object({
  plugins: z.array(pluginEntry).default([]),
  skills: z.array(skillEntry).default([]),
  knowledge: z.array(knowledgeEntry).default([]),
  slaude_skills: slaudeSkillsTarget.optional(),
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

export const lockfileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  marketplaces: z.record(z.string(), marketplaceEntryLock).default({}),
  skills: z.record(z.string(), skillLock).default({}),
  knowledge: z.record(z.string(), knowledgeLock).default({}),
});
export type Lockfile = z.infer<typeof lockfileSchema>;
