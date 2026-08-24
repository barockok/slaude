/**
 * Contract for the `slaude_skills` MCP server (skill evolution: introspect,
 * author, refine, retire skills).
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const SKILLS_SERVER = "slaude_skills";

export const skillsContract = {
  server: SKILLS_SERVER,
  tools: {
    list_skills: {
      name: "list_skills",
      description:
        "List installed skills (slug, name, description). Use to discover existing capabilities before authoring a new one — refine instead of duplicate.",
      schema: {},
    },
    read_skill: {
      name: "read_skill",
      description: "Read a skill's full SKILL.md. Use before refining so you preserve existing instructions.",
      schema: { slug: z.string().describe("Skill slug, e.g. 'release-notes'.") },
    },
    write_skill: {
      name: "write_skill",
      description:
        "Create or overwrite ~/.slaude/skills/<slug>/SKILL.md. Use to evolve yourself: when a turn demonstrates a repeatable procedure, capture it. Body supports ${SLAUDE_SKILL_DIR}, ${SLAUDE_SESSION_ID}, ${SLAUDE_SKILL_ARGS}.",
      schema: {
        slug: z
          .string()
          .describe("Lowercase a-z 0-9 -, ≤64 chars. Invoked as /<slug>."),
        name: z.string().describe("Human-readable name."),
        description: z
          .string()
          .describe("One-line description shown to the model on match."),
        body: z
          .string()
          .describe(
            "Markdown body — instructions executed on /<slug>. Use ${SLAUDE_SKILL_ARGS} for caller args.",
          ),
      },
    },
    delete_skill: {
      name: "delete_skill",
      description: "Delete a skill dir. Irreversible.",
      schema: { slug: z.string() },
    },
    sync_manifest: {
      name: "sync_manifest",
      description:
        "Sync runtime-created skills and knowledge bases back to slaude.json + slaude.lock. If SLAUDE_SKILLS_REPO is configured, pushes new skills to git; otherwise records them as local entries. Call sparingly — only after creating or evolving multiple skills or KBs. Returns JSON summary with synced_skills, synced_kbs, warnings, and skills_in_git.",
      schema: {},
    },
  },
} as const satisfies ServerContract;
