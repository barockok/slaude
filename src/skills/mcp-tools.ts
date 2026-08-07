import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { paths } from "../config/home";
import { discoverSkills, personaSkillsRoot, type Skill } from "./loader";
import { syncManifest } from "./sync-manifest";

export const SKILLS_MCP_NAME = "slaude_skills";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when a persona name denotes a real (non-default) persona. */
function namedPersona(personaName?: string): string | null {
  return personaName && personaName !== "default" ? personaName : null;
}

/**
 * Validate slug + resolve its dir under the skills root. Base root is
 * $SLAUDE_HOME/skills/; a named persona resolves under its overlay
 * (personas/<name>/skills/). Throws on invalid slug or any path-escape attempt.
 */
export function resolveSkillDir(slug: string, personaName?: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug "${slug}" — must match [a-z0-9][a-z0-9-]{0,63}`,
    );
  }
  const persona = namedPersona(personaName);
  const root = resolve(persona ? personaSkillsRoot(persona) : paths.skills);
  const dir = resolve(join(root, slug));
  const rel = relative(root, dir);
  if (rel !== slug) {
    throw new Error(`slug "${slug}" escapes skills root`);
  }
  return dir;
}

export function buildSkillMd(
  name: string,
  description: string,
  body: string,
): string {
  // JSON-quote frontmatter values so colons/newlines in name/description
  // can't break the yaml block.
  const fm = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
  ].join("\n");
  return `${fm}\n${body.endsWith("\n") ? body : body + "\n"}`;
}

export const skillOps = {
  list(personaName?: string): Skill[] {
    return discoverSkills(personaName);
  },
  read(slug: string, personaName?: string): string {
    // Effective read: a persona's overlay skill shadows the base of the same slug.
    if (namedPersona(personaName)) {
      const overlay = join(resolveSkillDir(slug, personaName), "SKILL.md");
      if (existsSync(overlay)) return readFileSync(overlay, "utf8");
    }
    const path = join(resolveSkillDir(slug), "SKILL.md");
    if (!existsSync(path)) throw new Error(`skill "${slug}" not found`);
    return readFileSync(path, "utf8");
  },
  write(
    slug: string,
    name: string,
    description: string,
    body: string,
    personaName?: string,
  ): { path: string; created: boolean } {
    // Named personas author into their own overlay; base stays shared/read-only.
    const dir = resolveSkillDir(slug, personaName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    const created = !existsSync(path);
    writeFileSync(path, buildSkillMd(name, description, body), "utf8");
    return { path, created };
  },
  delete(slug: string, personaName?: string): void {
    // A persona can only retire its own overlay skills, never a shared base skill.
    const dir = resolveSkillDir(slug, personaName);
    if (!existsSync(dir)) throw new Error(`skill "${slug}" not found`);
    rmSync(dir, { recursive: true, force: true });
  },
};

/**
 * Skill-evolution MCP server. Lets the agent introspect, author, refine, and
 * retire its own skills at ~/.slaude/skills/<slug>/SKILL.md.
 *
 * Hot-reload is free: discoverSkills() runs per inbound Slack message, so any
 * change written here is picked up on the next user turn.
 */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Build the skill MCP handlers bound to a persona (undefined/'default' = the
 *  shared base). Named personas read a merged base+overlay view but write/delete
 *  only into their own overlay. */
export function makeSkillHandlers(personaName?: string) {
  return {
    async list_skills(): Promise<ToolResult> {
      const skills = skillOps.list(personaName);
      if (skills.length === 0) return ok("(no skills installed)");
      return ok(
        skills
          .map(
            (s) =>
              `- /${s.slug}  —  ${s.name}: ${s.description || "(no description)"}`,
          )
          .join("\n"),
      );
    },
    async read_skill({ slug }: { slug: string }): Promise<ToolResult> {
      try {
        return ok(skillOps.read(slug, personaName));
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    },
    async write_skill({
      slug,
      name,
      description,
      body,
    }: {
      slug: string;
      name: string;
      description: string;
      body: string;
    }): Promise<ToolResult> {
      try {
        const r = skillOps.write(slug, name, description, body, personaName);
        return ok(
          `${r.created ? "created" : "updated"} skill /${slug} at ${r.path}`,
        );
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    },
    async delete_skill({ slug }: { slug: string }): Promise<ToolResult> {
      try {
        skillOps.delete(slug, personaName);
        return ok(`deleted skill /${slug}`);
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    },
    async sync_manifest(): Promise<ToolResult> {
      return syncManifest();
    },
  };
}

/** Default (shared-base) handlers, for callers that aren't persona-scoped. */
export const skillHandlers = makeSkillHandlers();

export function createSkillsMcp(personaName?: string): McpSdkServerConfigWithInstance {
  const handlers = makeSkillHandlers(personaName);
  return createSdkMcpServer({
    name: SKILLS_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "list_skills",
        "List installed skills (slug, name, description). Use to discover existing capabilities before authoring a new one — refine instead of duplicate.",
        {},
        handlers.list_skills,
      ),
      tool(
        "read_skill",
        "Read a skill's full SKILL.md. Use before refining so you preserve existing instructions.",
        { slug: z.string().describe("Skill slug, e.g. 'release-notes'.") },
        handlers.read_skill,
      ),
      tool(
        "write_skill",
        "Create or overwrite ~/.slaude/skills/<slug>/SKILL.md. Use to evolve yourself: when a turn demonstrates a repeatable procedure, capture it. Body supports ${SLAUDE_SKILL_DIR}, ${SLAUDE_SESSION_ID}, ${SLAUDE_SKILL_ARGS}.",
        {
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
        handlers.write_skill,
      ),
      tool(
        "delete_skill",
        "Delete a skill dir. Irreversible.",
        { slug: z.string() },
        handlers.delete_skill,
      ),
      tool(
        "sync_manifest",
        "Sync runtime-created skills and knowledge bases back to slaude.json + slaude.lock. If SLAUDE_SKILLS_REPO is configured, pushes new skills to git; otherwise records them as local entries. Call sparingly — only after creating or evolving multiple skills or KBs. Returns JSON summary with synced_skills, synced_kbs, warnings, and skills_in_git.",
        {},
        handlers.sync_manifest,
      ),
    ],
  });
}
