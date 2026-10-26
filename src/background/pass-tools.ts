/**
 * The tools a background pass may call (spec §9.1, invariants 1 and 2): the
 * in-process MCP server `slaude_pass`, called by the model as
 * `mcp__slaude_pass__<tool>`.
 *
 * Read-only plus auto-pass writes. Every read is limited to the pass scope's
 * read sources, one source per brain call:
 *   agent scope  `agent-<id>`, the legacy `agent`, `shared`, `public`, the persona's `kb-*`;
 *   user scope   that person's `user-<id>` and profile, plus the above, read-only.
 * No other `user-*` or `profile-*` source is ever read, so a pass never sees
 * two people's private slices at once.
 *
 * Writes go to one place only: the agent's slice (agent scope) or the run-as
 * person's `user-<id>` (user scope). In user scope, profile and correction
 * pages go to that person's profile, and only with a `quote` that appears
 * verbatim in one of that person's OWN turns in the transcripts the pass was
 * given (§8.3a); in agent scope a correction is a lesson candidate in the
 * agent's slice and a profile page is refused. Anything for `shared` becomes a
 * `propose` row instead (in user scope only kind `promote`, to that person).
 *
 * Tool results pass through redactSecrets, and a page or proposal carrying a
 * credential-like value is refused (CREDENTIAL_REFUSAL), as kb_memoize does.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { redactSecrets } from "../gateway/core/status-text";
import { gather } from "../knowledge/gather";
import { composePage, CREDENTIAL_REFUSAL, readPageRecord, type TypedPageInput } from "../knowledge/memory-pages";
import { getPageOrNull, SUPERSEDED_TAG, supersededSlugs, type BrainOpCall } from "../knowledge/memory-trail";
import { PAGE_TYPES, type PageType } from "../knowledge/page-types";
import { AGENT_SOURCE, agentSourceId, PUBLIC_SOURCE, SHARED_SOURCE, speakerProfileSource, userSourceId, type BrainScope } from "../knowledge/scope";
import * as Proposals from "../db/proposals";

export type PassScope = { kind: "agent" } | { kind: "user"; userId: string; teamId: string };

/** One transcript turn handed to a pass. `author` is the Slack user id of who wrote it, or "agent". */
export interface TranscriptTurn {
  at: string;
  author: string;
  text: string;
}

/** An extra tool a pass mounts on `slaude_pass` (e.g. the skill review's list_skills). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PassTool = SdkMcpToolDefinition<any>;

export const PASS_MCP_NAME = "slaude_pass";
export const PASS_TOOL_NAMES = ["read_pages", "list_pages", "search", "memoize", "propose"] as const;

/** The name the model calls a slaude_pass tool by. */
export const passToolId = (name: string): string => `mcp__${PASS_MCP_NAME}__${name}`;

export interface PassToolContext {
  scope: PassScope;
  agentId: string;
  /** The persona's readable `kb-*` sources; anything else in the list is ignored. */
  kbSources: string[];
  transcripts: TranscriptTurn[];
  call: BrainOpCall;
  now: () => Date;
}

/** Most pages one read_pages or memoize call takes. */
export const PASS_MAX_PAGES = 20;
/** A `lessons` page holds at most this many lines (global constraints). */
export const LESSONS_MAX_LINES = 40;
/** A quote shorter than this would match almost any turn. */
export const MIN_QUOTE_CHARS = 8;
/** Largest proposal payload, as JSON. */
export const MAX_PROPOSAL_CHARS = 8000;
const LIST_LIMIT = 200;

export const SHARED_REFUSAL =
  'refused: a background pass cannot write to shared; use propose (kind "team-fact" or "promote") so the right person can approve it';
export const PROFILE_SCOPE_REFUSAL =
  "refused: a profile is written only by a pass running as that person, quoting their own words";
export const QUOTE_REFUSAL = "refused: a profile entry must quote that person's own words";
export const SOURCE_REFUSAL = "refused: that source is outside this pass's scope";
export const NO_PROFILE_REFUSAL = "refused: this person's profile is unavailable to this pass (no Slack team id)";
export const CORRECTION_SLUG_REFUSAL = 'refused: a correction page may not use slug "profile"';
export const USER_PROPOSAL_KIND_REFUSAL = 'refused: a pass running as a person proposes only kind "promote"';
export const LESSONS_REFUSAL = `refused: a lessons page holds at most ${LESSONS_MAX_LINES} lines; merge or drop lessons before adding`;
export const CONVERSATION_REFUSAL = "refused: conversation pages and their summaries are never written with memoize";
export const PROPOSE_TO_PERSON_REFUSAL = 'refused: an agent-scope pass proposes only to the manager (to: "manager")';

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: redactSecrets(typeof v === "string" ? v : JSON.stringify(v, null, 2)) }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text: redactSecrets(text) }], isError: true });
const brainErr = (op: string, e: unknown): ToolResult => err(`brain ${op} failed: ${e instanceof Error ? e.message : String(e)}`);

/** The run-as person's sources, checked: null when the user id is unusable. */
function personSources(scope: Extract<PassScope, { kind: "user" }>): { own: string; profile: string | null } | null {
  if (!scope.userId || userSourceId(scope.userId) === "user-") return null;
  return { own: userSourceId(scope.userId), profile: speakerProfileSource(scope.teamId, scope.userId) };
}

/** Every source a pass in `scope` may read, in read order. */
export function passReadSources(scope: PassScope, agentId: string, kbSources: readonly string[]): string[] {
  // The legacy single-agent `agent` source rides along read-only, as in resolveBrainScope.
  const common = [agentSourceId(agentId), AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, ...kbSources.filter((s) => s.startsWith("kb-"))];
  if (scope.kind === "agent") return [...new Set(common)];
  const p = personSources(scope);
  if (!p) throw new Error("user-scope pass needs a usable userId");
  return [...new Set([p.own, ...(p.profile ? [p.profile] : []), ...common])];
}

/** The run-as person's profile source, or null when there is none (an empty or unusable team id). */
export function passProfileSource(scope: PassScope): string | null {
  return scope.kind === "user" ? (personSources(scope)?.profile ?? null) : null;
}

/** Where the pass's ordinary (non-profile) pages are written. */
export function passWriteSource(scope: PassScope, agentId: string): string {
  if (scope.kind === "agent") return agentSourceId(agentId);
  const p = personSources(scope);
  if (!p) throw new Error("user-scope pass needs a usable userId");
  return p.own;
}

const clientOf = (ctx: PassToolContext): string => (ctx.scope.kind === "user" ? ctx.scope.userId : ctx.agentId);
const only = (ctx: PassToolContext, source: string): BrainScope => ({ clientId: clientOf(ctx), sourceId: source, allowedSources: [source] });

/** The sources a read covers: the one named (if readable), else all. */
function readTargets(ctx: PassToolContext, source: string | undefined): string[] | null {
  const all = passReadSources(ctx.scope, ctx.agentId, ctx.kbSources);
  if (source === undefined) return all;
  return all.includes(source) ? [source] : null;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** True when `quote` appears verbatim (whitespace collapsed) in a turn `userId` wrote. */
export function quotedFromOwnTurn(quote: string | undefined, userId: string, transcripts: readonly TranscriptTurn[]): boolean {
  if (quote === undefined) return false;
  const q = squash(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return transcripts.some((t) => t.author === userId && squash(t.text).includes(q));
}

const lineCount = (s: string): number => s.replace(/\s+$/, "").split(/\r?\n/).length;

const PAGE_TYPE_ENUM = PAGE_TYPES as unknown as [PageType, ...PageType[]];

const pageSchema = z.object({
  slug: z.string().describe("Page slug, e.g. 'people/U123' or 'self/lesson-proposals'."),
  content: z.string().describe("The page body (no frontmatter)."),
  type: z.enum(PAGE_TYPE_ENUM).describe("Page type; generates the common frontmatter."),
  confidence: z.enum(["told", "inferred"]).optional(),
  source: z.string().optional().describe("Where it came from: a thread permalink or \"told by <user>\"."),
  subject: z.string().optional().describe("Slack user id the page is about."),
  supersedes: z.string().optional().describe("Slug of the older page this one replaces, in the same memory."),
  fields: z.record(z.string(), z.string()).optional().describe("Type-specific frontmatter keys, one line each."),
  quote: z.string().optional().describe("Profile and correction pages: the person's own words, copied verbatim from one of their turns."),
  target: z.enum(["mine", "profile", "shared"]).optional().describe('"mine" (default) = this pass\'s slice; "profile" = the run-as person\'s profile; "shared" is refused (use propose).'),
});
type PassPage = z.infer<typeof pageSchema>;

interface Composed {
  slug: string;
  content: string;
  source: string;
  supersedes?: string;
}

/** Destination and composed markdown for one page, or the refusal. */
function composeOne(pg: PassPage, ctx: PassToolContext, now: Date): Composed | { error: string } {
  if (pg.target === "shared" || pg.type === "team-fact") return { error: SHARED_REFUSAL };
  // A transcript is appended by memory sync only; its summary is the quiet-moment pass's own tool.
  if (/^[/.]*conversations(\/|$)/i.test(pg.slug.trim()))return { error: CONVERSATION_REFUSAL };
  if (pg.type === "correction" && pg.slug === "profile") return { error: CORRECTION_SLUG_REFUSAL };
  // A correction is about how to treat the run-as person (their profile) in a
  // user-scope pass; in an agent-scope pass it is a lesson candidate in the
  // agent's own slice (spec §8.2).
  const toProfile = pg.target === "profile" || pg.type === "profile" || (pg.type === "correction" && ctx.scope.kind === "user");
  if (!toProfile) {
    if (pg.type === "lessons" && lineCount(pg.content) > LESSONS_MAX_LINES) return { error: LESSONS_REFUSAL };
    const { quote: _q, target: _t, ...page } = pg;
    const c = composePage(page as TypedPageInput, now);
    if ("error" in c) return c;
    return { slug: pg.slug, content: c.content, source: passWriteSource(ctx.scope, ctx.agentId), ...(pg.supersedes !== undefined ? { supersedes: pg.supersedes } : {}) };
  }
  if (ctx.scope.kind !== "user") return { error: PROFILE_SCOPE_REFUSAL };
  const profile = passProfileSource(ctx.scope);
  if (profile === null) return { error: NO_PROFILE_REFUSAL };
  if (pg.type !== "profile" && pg.type !== "correction") return { error: 'refused: the profile takes pages of type profile or correction' };
  if (pg.type === "profile" && pg.slug !== "profile") return { error: 'refused: a profile page uses slug "profile"' };
  const userId = ctx.scope.userId;
  if (pg.subject !== undefined && pg.subject !== userId) return { error: QUOTE_REFUSAL };
  if (!quotedFromOwnTurn(pg.quote, userId, ctx.transcripts)) return { error: QUOTE_REFUSAL };
  const { quote, target: _t, ...page } = pg;
  const c = composePage(
    { ...page, subject: userId, source: pg.source ?? `told by ${userId}`, fields: { ...(pg.fields ?? {}), quote: squash(quote!) } },
    now,
  );
  if ("error" in c) return c;
  return { slug: pg.slug, content: c.content, source: profile, ...(pg.supersedes !== undefined ? { supersedes: pg.supersedes } : {}) };
}

/**
 * True when any string in `v` (recursively, keys included) looks like a
 * credential: the string alone, and each object entry rendered as `key: value`,
 * since JSON's `"api_key":"…"` shape is not what redactSecrets matches.
 */
export function holdsCredential(v: unknown, key?: string): boolean {
  if (typeof v === "string") {
    if (redactSecrets(v) !== v) return true;
    return key !== undefined && redactSecrets(`${key}: ${v}`) !== `${key}: ${v}`;
  }
  if (typeof v === "number" || typeof v === "boolean") return key !== undefined && holdsCredential(String(v), key);
  if (Array.isArray(v)) return v.some((x) => holdsCredential(x, key));
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => holdsCredential(k) || holdsCredential(x, k));
  }
  return false;
}

export const passHandlers = {
  async read_pages(p: { slugs: string[]; source?: string }, ctx: PassToolContext): Promise<ToolResult> {
    const sources = readTargets(ctx, p.source);
    if (!sources) return err(SOURCE_REFUSAL);
    if (!Array.isArray(p.slugs) || p.slugs.length === 0 || p.slugs.length > PASS_MAX_PAGES) {
      return err(`read_pages takes 1..${PASS_MAX_PAGES} slugs`);
    }
    try {
      const pages: Array<{ slug: string; source: string; meta: Record<string, string>; body: string; superseded: boolean }> = [];
      const missing: string[] = [];
      for (const slug of p.slugs) {
        let found = false;
        for (const source of sources) {
          const rec = readPageRecord(await getPageOrNull(ctx.call, slug, only(ctx, source)));
          if (!rec) continue;
          found = true;
          pages.push({ slug, source, ...rec });
        }
        if (!found) missing.push(slug);
      }
      return ok({ pages, ...(missing.length > 0 ? { missing } : {}) });
    } catch (e) {
      return brainErr("get_page", e);
    }
  },

  async list_pages(p: { type?: string; tag?: string; source?: string }, ctx: PassToolContext): Promise<ToolResult> {
    const sources = readTargets(ctx, p.source);
    if (!sources) return err(SOURCE_REFUSAL);
    try {
      const out: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        const params: Record<string, unknown> = { limit: LIST_LIMIT };
        if (p.type !== undefined) params.type = p.type;
        if (p.tag !== undefined) params.tag = p.tag;
        const rows = await ctx.call("list_pages", params, only(ctx, source));
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          const row = (r ?? {}) as Record<string, unknown>;
          if (typeof row.slug !== "string") continue;
          out.push({ slug: row.slug, source, ...(row.title !== undefined ? { title: row.title } : {}), ...(row.type !== undefined ? { type: row.type } : {}), ...(row.updated_at !== undefined ? { updated_at: row.updated_at } : {}) });
        }
      }
      return ok(out);
    } catch (e) {
      return brainErr("list_pages", e);
    }
  },

  async search(p: { query: string; source?: string; limit?: number }, ctx: PassToolContext): Promise<ToolResult> {
    const sources = readTargets(ctx, p.source);
    if (!sources) return err(SOURCE_REFUSAL);
    try {
      const scope: BrainScope = { clientId: clientOf(ctx), sourceId: sources[0]!, allowedSources: sources };
      return ok(await gather(p.query, scope, { finalLimit: Math.min(Math.max(p.limit ?? 20, 1), 50), call: ctx.call }));
    } catch (e) {
      return brainErr("search", e);
    }
  },

  async memoize(p: { pages: PassPage[] }, ctx: PassToolContext): Promise<ToolResult> {
    const pages = p.pages;
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > PASS_MAX_PAGES) {
      return err(`memoize takes 1..${PASS_MAX_PAGES} pages`);
    }
    // Compose every page before anything is written: one refusal stops the batch.
    const now = ctx.now();
    const composed: Composed[] = [];
    for (const pg of pages) {
      const c = composeOne(pg, ctx, now);
      if ("error" in c) return err(c.error);
      composed.push(c);
    }
    const writing = new Set(composed.map((c) => `${c.source}\n${c.slug}`));
    for (const c of composed) {
      if (c.supersedes === undefined) continue;
      if (c.supersedes === c.slug || writing.has(`${c.source}\n${c.supersedes}`)) return err("refused: a page cannot supersede itself or a page this call writes");
    }
    try {
      // An older page can be retired only in the memory the new page goes to.
      for (const c of composed) {
        if (c.supersedes !== undefined && !(await getPageOrNull(ctx.call, c.supersedes, only(ctx, c.source)))) {
          return err(`refused: ${c.supersedes} is not a page in the memory ${c.slug} is written to`);
        }
      }
      const written: Array<{ slug: string; source: string }> = [];
      for (const source of new Set(composed.map((c) => c.source))) {
        const mine = composed.filter((c) => c.source === source);
        const tagged = await supersededSlugs(ctx.call, only(ctx, source), [source]);
        for (const c of mine) {
          await ctx.call("put_page", { slug: c.slug, content: c.content }, only(ctx, source));
          written.push({ slug: c.slug, source });
        }
        // A page written again is current again.
        for (const c of mine) if (tagged.has(c.slug)) await ctx.call("remove_tag", { slug: c.slug, tag: SUPERSEDED_TAG }, only(ctx, source));
        for (const c of mine) if (c.supersedes !== undefined) await ctx.call("add_tag", { slug: c.supersedes, tag: SUPERSEDED_TAG }, only(ctx, source));
      }
      return ok({ written });
    } catch (e) {
      return brainErr("put_page", e);
    }
  },

  async propose(
    p: { kind: Proposals.ProposalKind; payload: Record<string, unknown>; to: Proposals.ProposalTo },
    ctx: PassToolContext,
  ): Promise<ToolResult> {
    if (!Proposals.PROPOSAL_KINDS.includes(p.kind)) return err(`refused: kind must be one of ${Proposals.PROPOSAL_KINDS.join(", ")}`);
    if (p.payload === null || typeof p.payload !== "object" || Array.isArray(p.payload)) return err("refused: payload must be an object");
    const json = JSON.stringify(p.payload);
    if (json.length > MAX_PROPOSAL_CHARS) return err(`refused: payload is over ${MAX_PROPOSAL_CHARS} characters`);
    if (holdsCredential(p.payload)) return err(CREDENTIAL_REFUSAL);
    if (ctx.scope.kind === "user" && p.kind !== "promote") return err(USER_PROPOSAL_KIND_REFUSAL);
    let toKind: Proposals.ProposalTo;
    let toUser: string | null;
    if (ctx.scope.kind === "user") {
      // /1on1 content goes only to its owner (invariant 1).
      toKind = "person";
      toUser = ctx.scope.userId;
    } else {
      if (p.to !== "manager") return err(PROPOSE_TO_PERSON_REFUSAL);
      toKind = "manager";
      toUser = null;
    }
    const createdAt = ctx.now().getTime();
    const id = await Proposals.insert({
      agentId: ctx.agentId,
      kind: p.kind,
      toKind,
      toUser,
      scope: ctx.scope.kind === "user" ? `user:${ctx.scope.userId}` : "agent",
      payload: p.payload,
      createdAt,
    });
    return ok({ proposed: id, to: toKind, expires_at: new Date(createdAt + Proposals.PROPOSAL_TTL_MS).toISOString() });
  },
};

const SOURCE_ARG = z.string().optional().describe("Read only this source (one of this pass's read sources).");

/** The pass's own tools, bound to `ctx`. */
export function passTools(ctx: PassToolContext): PassTool[] {
  // Each tool() is typed by its own schema; the server takes them as one list.
  const tools = [
    tool("read_pages", "Read brain pages by slug from this pass's read sources. Returns each page found with its source, frontmatter and body.",
      { slugs: z.array(z.string()).min(1).max(PASS_MAX_PAGES), source: SOURCE_ARG },
      (a) => passHandlers.read_pages(a, ctx)),
    tool("list_pages", "List brain pages in this pass's read sources, optionally by page type or tag.",
      { type: z.string().optional(), tag: z.string().optional(), source: SOURCE_ARG },
      (a) => passHandlers.list_pages(a, ctx)),
    tool("search", "Search this pass's read sources. Returns ranked hits with slugs and sources.",
      { query: z.string(), source: SOURCE_ARG, limit: z.number().optional() },
      (a) => passHandlers.search(a, ctx)),
    tool("memoize", `Write typed pages (1..${PASS_MAX_PAGES}). Ordinary pages go to this pass's own slice. In a pass running as a person, profile and correction pages go to that person's profile and need \`quote\`: their own words, copied verbatim from one of their turns. In an agent pass a correction is a lesson candidate in the agent's slice. Nothing can be written to shared: use propose.`,
      { pages: z.array(pageSchema).min(1).max(PASS_MAX_PAGES) },
      (a) => passHandlers.memoize(a, ctx)),
    tool("propose", "Queue a proposal that needs someone's approval (a team fact for shared, promoting private content, removing a skill, promoting a lesson into the SOUL). It becomes a card; nothing is written until it is approved, and it expires after 14 days.",
      {
        kind: z.enum(["team-fact", "promote", "skill-removal", "lesson-promotion"]),
        payload: z.record(z.string(), z.unknown()),
        to: z.enum(["manager", "person"]),
      },
      (a) => passHandlers.propose(a as Parameters<typeof passHandlers.propose>[0], ctx)),
  ];
  return tools as unknown as PassTool[];
}

/** The `slaude_pass` server: the pass's tools plus `extra`. A name collision throws. */
export function createPassMcpServer(ctx: PassToolContext, extra: readonly PassTool[] = []): { server: McpSdkServerConfigWithInstance; toolIds: string[] } {
  const tools = [...passTools(ctx), ...extra];
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error(`slaude_pass: duplicate tool name in ${names.join(", ")}`);
  return { server: createSdkMcpServer({ name: PASS_MCP_NAME, version: "0.1.0", tools }), toolIds: names.map(passToolId) };
}
