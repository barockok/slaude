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
import { discoverSkills, type Skill } from "./loader";
import { syncManifest } from "./sync-manifest";

export const SKILLS_MCP_NAME = "slaude_skills";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate slug + resolve its dir under $SLAUDE_HOME/skills/. Returns the
 * absolute dir path. Throws on invalid slug or any path-escape attempt.
 */
export function resolveSkillDir(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug "${slug}" — must match [a-z0-9][a-z0-9-]{0,63}`,
    );
  }
  const root = resolve(paths.skills);
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
  list(): Skill[] {
    return discoverSkills();
  },
  read(slug: string): string {
    const dir = resolveSkillDir(slug);
    const path = join(dir, "SKILL.md");
    if (!existsSync(path)) throw new Error(`skill "${slug}" not found`);
    return readFileSync(path, "utf8");
  },
  write(
    slug: string,
    name: string,
    description: string,
    body: string,
  ): { path: string; created: boolean } {
    const dir = resolveSkillDir(slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    const created = !existsSync(path);
    writeFileSync(path, buildSkillMd(name, description, body), "utf8");
    return { path, created };
  },
  delete(slug: string): void {
    const dir = resolveSkillDir(slug);
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

export const skillHandlers = {
  async list_skills(): Promise<ToolResult> {
    const skills = skillOps.list();
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
      return ok(skillOps.read(slug));
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
      const r = skillOps.write(slug, name, description, body);
      return ok(
        `${r.created ? "created" : "updated"} skill /${slug} at ${r.path}`,
      );
    } catch (e: any) {
      return err(e?.message ?? String(e));
    }
  },
  async delete_skill({ slug }: { slug: string }): Promise<ToolResult> {
    try {
      skillOps.delete(slug);
      return ok(`deleted skill /${slug}`);
    } catch (e: any) {
      return err(e?.message ?? String(e));
    }
  },
  async sync_manifest(): Promise<ToolResult> {
    return syncManifest();
  },
};

export function createSkillsMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SKILLS_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "list_skills",
        "List installed skills (slug, name, description). Use to discover existing capabilities before authoring a new one — refine instead of duplicate.",
        {},
        skillHandlers.list_skills,
      ),
      tool(
        "read_skill",
        "Read a skill's full SKILL.md. Use before refining so you preserve existing instructions.",
        { slug: z.string().describe("Skill slug, e.g. 'release-notes'.") },
        skillHandlers.read_skill,
      ),
      tool(
        "write_skill",
        "Create or overwrite ~/.slaude/skills/<slug>/SKILL.md. Use to evolve yourself: when a turn demonstrates a repeatable procedure, capture it. REQUIRES prior approval via `mcp__slaude_surface__request_approval` (category='skills'). Body supports ${SLAUDE_SKILL_DIR}, ${SLAUDE_SESSION_ID}, ${SLAUDE_SKILL_ARGS}.",
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
        skillHandlers.write_skill,
      ),
      tool(
        "delete_skill",
        "Delete a skill dir. REQUIRES prior approval (category='skills'). Irreversible.",
        { slug: z.string() },
        skillHandlers.delete_skill,
      ),
      tool(
        "sync_manifest",
        "Sync runtime-created skills and knowledge bases back to slaude.json + slaude.lock. If SLAUDE_SKILLS_REPO is configured, pushes new skills to git; otherwise records them as local entries. Call sparingly — only after creating or evolving multiple skills or KBs. Returns JSON summary with synced_skills, synced_kbs, warnings, and skills_in_git.",
        {},
        skillHandlers.sync_manifest,
      ),
    ],
  });
}
