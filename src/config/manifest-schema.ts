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
  git: gitUrl,
  ref: z.string().min(1),
  slug: z.string().min(1).optional(),
});
export type SkillEntry = z.infer<typeof skillEntry>;

export const knowledgeEntry = z.object({
  label: z.string().min(1),
  git: gitUrl,
  ref: z.string().min(1),
});
export type KnowledgeEntry = z.infer<typeof knowledgeEntry>;

export const manifestSchema = z.object({
  plugins: z.array(pluginEntry).default([]),
  skills: z.array(skillEntry).default([]),
  knowledge: z.array(knowledgeEntry).default([]),
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
});
const knowledgeLock = z.object({
  git: z.string(),
  ref: z.string(),
  sha: z.string().length(40),
});

export const lockfileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  marketplaces: z.record(z.string(), marketplaceEntryLock).default({}),
  skills: z.record(z.string(), skillLock).default({}),
  knowledge: z.record(z.string(), knowledgeLock).default({}),
});
export type Lockfile = z.infer<typeof lockfileSchema>;
