import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { discoverSkills, globalSkillsRoot, personaSkillsRoot, RETIRED_DIR, skillFileName, type Skill } from "./loader";
import { syncManifest } from "./sync-manifest";
import { builtinSkillRefusal, cliSkillName, isBuiltinSkillName } from "../soul/builtin";
import { skillsContract } from "../tools/contracts/skills";

export const SKILLS_MCP_NAME = skillsContract.server;

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
  const root = resolve(persona ? personaSkillsRoot(persona) : globalSkillsRoot());
  const dir = resolve(join(root, slug));
  const rel = relative(root, dir);
  if (rel !== slug) {
    throw new Error(`slug "${slug}" escapes skills root`);
  }
  return dir;
}

/** Provenance stamped into a skill's frontmatter by write_skill. */
export interface SkillAuthorship {
  authoredBy: "agent";
  /** ISO time of the write. */
  authoredAt: string;
}

export function buildSkillMd(
  name: string,
  description: string,
  body: string,
  authorship?: SkillAuthorship,
): string {
  // JSON-quote frontmatter values so colons/newlines in name/description
  // can't break the yaml block. The provenance keys come only from the
  // caller, never from the model: the body follows the closing `---`, so it
  // cannot add a frontmatter key.
  const fm = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    ...(authorship
      ? [`authored_by: ${JSON.stringify(authorship.authoredBy)}`, `authored_at: ${JSON.stringify(authorship.authoredAt)}`]
      : []),
    "---",
  ].join("\n");
  return `${fm}\n${body.endsWith("\n") ? body : body + "\n"}`;
}

/** Built-in skills ship read-only with the release: no runtime write, delete
 *  or persona-overlay shadow of their bare name. Reads stay allowed. */
function assertNotBuiltin(slug: string): void {
  if (isBuiltinSkillName(slug)) {
    throw new Error(builtinSkillRefusal(slug));
  }
}

/** The skills root a persona authors into: its overlay when named, else the shared base. */
function ownSkillsRoot(personaName?: string): string {
  const persona = namedPersona(personaName);
  return resolve(persona ? personaSkillsRoot(persona) : globalSkillsRoot());
}

/** A retired copy's id: `<slug>-<UTC yyyymmddThhmmssZ>`, plus `-<n>` when that second is taken. */
const RETIRED_ID_RE = /^([a-z0-9][a-z0-9-]{0,63})-(\d{8}T\d{6}Z)(?:-(\d{1,3}))?$/;

/** `2026-10-26T15:04:05.123Z` → `20261026T150405Z`. */
const utcStamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

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
  /**
   * Write a skill, stamped `authored_by: agent` and `authored_at` (now). The
   * stamp is not provenance by itself: a slug in slaude.lock or the bundled
   * seed stays installed/bundled however its frontmatter reads (provenance.ts).
   */
  write(
    slug: string,
    name: string,
    description: string,
    body: string,
    personaName?: string,
    now: Date = new Date(),
  ): { path: string; created: boolean } {
    assertNotBuiltin(slug);
    // The CLI names the skill after its frontmatter `name`, not the slug: a
    // free slug carrying a built-in's name would answer for it whenever another
    // plugin also resolves to the name "slaude".
    assertNotBuiltin(cliSkillName(name));
    // Named personas author into their own overlay; base stays shared/read-only.
    const dir = resolveSkillDir(slug, personaName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    const created = !existsSync(path);
    writeFileSync(path, buildSkillMd(name, description, body, { authoredBy: "agent", authoredAt: now.toISOString() }), "utf8");
    return { path, created };
  },
  delete(slug: string, personaName?: string): void {
    assertNotBuiltin(slug);
    // A persona can only retire its own overlay skills, never a shared base skill.
    const dir = resolveSkillDir(slug, personaName);
    if (!existsSync(dir)) throw new Error(`skill "${slug}" not found`);
    rmSync(dir, { recursive: true, force: true });
  },
  /**
   * Soft delete: move the skill's directory to
   * `<root>/.retired/<slug>-<UTC timestamp>/` in the root it lives in (the
   * persona's overlay when named, else the shared base), where neither the
   * loader nor the CLI reads it. Returns the retired id that restore takes.
   * The slug is free again for write_skill.
   */
  retire(slug: string, personaName?: string, now: Date = new Date()): { id: string; path: string } {
    assertNotBuiltin(slug);
    const dir = resolveSkillDir(slug, personaName);
    if (!existsSync(dir)) throw new Error(`skill "${slug}" not found`);
    const store = join(ownSkillsRoot(personaName), RETIRED_DIR);
    mkdirSync(store, { recursive: true });
    const base = `${slug}-${utcStamp(now)}`;
    let id = base;
    for (let n = 2; existsSync(join(store, id)); n++) {
      if (n > 999) throw new Error(`skill "${slug}": too many retired copies at ${base}`);
      id = `${base}-${n}`;
    }
    const path = join(store, id);
    renameSync(dir, path);
    return { id, path };
  },
  /**
   * Move a retired copy back to its slug. Refused when a live skill holds
   * that slug (it was written again since), or the slug or the copy's
   * frontmatter `name` is now a built-in's.
   */
  restore(id: string, personaName?: string): { slug: string; path: string } {
    const m = id.match(RETIRED_ID_RE);
    if (!m) throw new Error(`invalid retired skill id "${id}"`);
    const slug = m[1]!;
    assertNotBuiltin(slug);
    const from = join(ownSkillsRoot(personaName), RETIRED_DIR, id);
    if (!existsSync(join(from, "SKILL.md"))) throw new Error(`retired skill "${id}" not found`);
    // The CLI names a skill after its frontmatter `name` (invariant 9, as write does).
    const name = skillFileName(join(from, "SKILL.md")) ?? "";
    if (name) {
      assertNotBuiltin(name);
      assertNotBuiltin(cliSkillName(name));
    }
    const dir = resolveSkillDir(slug, personaName);
    if (existsSync(dir)) throw new Error(`a live skill "${slug}" exists; retire or delete it before restoring "${id}"`);
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(from, dir);
    return { slug, path: dir };
  },
  /** The retired copies in a persona's own root, by id (newest timestamp last). */
  listRetired(personaName?: string): string[] {
    const store = join(ownSkillsRoot(personaName), RETIRED_DIR);
    if (!existsSync(store)) return [];
    return readdirSync(store).filter((e) => RETIRED_ID_RE.test(e)).sort();
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
  const c = skillsContract.tools;
  return createSdkMcpServer({
    name: SKILLS_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(c.list_skills.name, c.list_skills.description, c.list_skills.schema, handlers.list_skills),
      tool(c.read_skill.name, c.read_skill.description, c.read_skill.schema, handlers.read_skill),
      tool(c.write_skill.name, c.write_skill.description, c.write_skill.schema, handlers.write_skill),
      tool(c.delete_skill.name, c.delete_skill.description, c.delete_skill.schema, handlers.delete_skill),
      tool(c.sync_manifest.name, c.sync_manifest.description, c.sync_manifest.schema, handlers.sync_manifest),
    ],
  });
}
