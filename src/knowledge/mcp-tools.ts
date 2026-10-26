import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadKbs, type KbEntry } from "./loader";
import { brainCall, brainEnabled } from "./brain";
import { brainThink, sdkThinkClient, synthesizeFromHits } from "./brain-think";
import { gather } from "./gather";
import { gatedBrainCall, soleSlackSender, type ApprovalReq, type ApprovalRes, type GateInput, type TurnSender } from "./gated-dispatch";
import { AGENT_SOURCE, PUBLIC_SOURCE, SHARED_SOURCE, kbSourceId, speakerProfileSource, userSourceId, type BrainScope } from "./scope";
import { carriedFields, composePage, readPageRecord, type TypedPageInput } from "./memory-pages";
import { SUPERSEDED_TAG, getPageOrNull, supersededSlugs } from "./memory-trail";
import { agentIdReady } from "./agent-identity";
import { conversationSlug, conversationSummarySlug, orderTimeline, type TimelineRow } from "../memory/brain-provider";
import { kbContract, KB_MEMOIZE_MAX_PAGES } from "../tools/contracts/kb";

export const KB_MCP_NAME = kbContract.server;
// Re-export: the limit is defined in the shared contract (single source of truth)
// but existing import sites read it from here.
export { KB_MEMOIZE_MAX_PAGES };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function scoreKb(kb: ReturnType<typeof loadKbs>[number], queryTokens: string[]): number {
  let score = 0;
  const labelTokens = tokenize(kb.label);
  const descTokens = tokenize(kb.description);
  // Split hyphenated tags so "service-a" yields "service-a", "service", "a"
  const tagTokens = kb.tags.flatMap((t) => [t, ...t.split(/[^a-z0-9]+/)]);
  for (const qt of queryTokens) {
    if (tagTokens.some((t) => t === qt)) score += 10;
    if (labelTokens.some((t) => t === qt)) score += 5;
    if (labelTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 2;
    if (descTokens.some((t) => t === qt)) score += 3;
    if (descTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
  }
  return score;
}

/** What list_kbs/search_kbs return per KB: no disk path or file name (WS-C
 *  §4.1.4). `source` is the brain source id kb_search reads it under. */
const kbView = (kb: KbEntry) => ({ label: kb.label, description: kb.description, tags: kb.tags, source: kbSourceId(kb.label) });

const NO_KBS = "(no knowledge bases available)";

/**
 * `kbs` is the caller's persona-filtered list (personaKbs); the default, every
 * installed KB, is for callers with no persona. A persona never learns that a
 * KB it may not read exists.
 */
export const kbHandlers = {
  async list_kbs(kbs: KbEntry[] = loadKbs()): Promise<ToolResult> {
    if (kbs.length === 0) return ok(NO_KBS);
    return ok(JSON.stringify(kbs.map(kbView), null, 2));
  },

  async search_kbs({ query, limit }: { query: string; limit?: number }, kbs: KbEntry[] = loadKbs()): Promise<ToolResult> {
    if (kbs.length === 0) return ok(NO_KBS);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return err("query too short or empty after tokenization");
    const scored = kbs
      .map((kb) => ({ kb, score: scoreKb(kb, queryTokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 5)
      .map((s) => kbView(s.kb));
    if (scored.length === 0) return ok("(no matching knowledge bases)");
    return ok(JSON.stringify(scored, null, 2));
  },
};

export interface BrainToolDeps {
  scope: () => BrainScope | Promise<BrainScope>;
  gate: () => GateInput | Promise<GateInput>;
  /** Manager + backup user ids — hard backstop for kb-admin approvals. */
  managers: () => string[];
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  /** This thread's session and the scope its turns may be read in (the memory
   *  read scope), per call. Absent: kb_thread_history is not offered. */
  thread?: () => Promise<{ sessionId: string | undefined; read: BrainScope | null }>;
  /** Injectable op caller (tests). Default: brainCall with current scope. */
  call?: (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;
  /** Injectable think (tests). Default: brainThink (SDK-routed synthesis). */
  think?: (question: string, scope: BrainScope) => Promise<unknown>;
  /** Told the pages a kb_memoize call wrote, after the write succeeded (the
   *  commitment index). Awaited, but a failure is logged, never returned. */
  onWritten?: (pages: Array<{ slug: string; content: string; source: string }>, scope: BrainScope) => Promise<void> | void;
}

const asJson = (v: unknown): ToolResult => ok(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * Map raw brain/Postgres errors to actionable agent-facing text. A leaked
 * `pages_source_id_fkey` / `$libdir/vector` string is meaningless to the agent
 * and led it to abandon the brain and silently write files instead (Mode A).
 * Translate known shapes into "what to do"; pass unknown errors through.
 * See docs/findings/2026-06-14-brain-memoize-failure.md.
 */
export function humanizeBrainError(name: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/pages_source_id_fkey|foreign key constraint|source.*not.*(exist|registered)/i.test(raw)) {
    return `brain ${name} failed: the target brain source isn't ready yet. This is a transient brain-write error — retry the same ${name} call once. If it still fails, tell the user the write did NOT land and ask the manager; do NOT fall back to writing a file or claim it was saved.`;
  }
  if (/\$libdir\/vector|could not access file|extension .*vector/i.test(raw)) {
    return `brain ${name} failed: the brain's vector extension is unavailable, so embeddings/search can't run. This is an infrastructure fault, not your input — tell the user the brain is degraded; do NOT work around it with files.`;
  }
  return `brain ${name} failed: ${raw}`;
}

async function runRead(name: string, params: Record<string, unknown>, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    return asJson(await call(name, params, await d.scope()));
  } catch (e) {
    return err(humanizeBrainError(name, e));
  }
}

async function runGated(name: string, params: Record<string, unknown>, summary: string, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    const r = await gatedBrainCall(name, {
      scope: await d.scope(),
      gate: await d.gate(),
      managers: d.managers(),
      requestApproval: d.requestApproval,
      call: async () => call(name, params, await d.scope()),
      describe: summary,
    });
    return r.ok ? asJson(r.result) : err(r.reason);
  } catch (e) {
    return err(humanizeBrainError(name, e));
  }
}

// Question words / stopwords stripped before the kb_think cross-check search.
// A verbose NL question ("what's our company wide OKR?") dilutes both the vector
// and keyword arms; the distilled keyword form ("company wide okr") ranks the
// canonical page far higher (jot-deployment case: full-question kb_think missed,
// tight kb_search hit rank 1). See docs/findings/2026-06-14-brain-memoize-failure.md.
const THINK_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does",
  "did", "what", "whats", "which", "who", "whom", "whose", "when", "where", "why",
  "how", "our", "your", "my", "we", "you", "i", "me", "us", "it", "its", "of", "to",
  "in", "on", "for", "about", "with", "and", "or", "tell", "know", "have", "has",
  "give", "show", "find", "any", "anything", "current", "currently", "please",
]);

/** Distill a verbose NL question to its content keywords for the cross-check
 *  search. Falls back to the original question if distillation empties it. */
export function distillQuery(question: string): string {
  const kept = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !THINK_STOPWORDS.has(t));
  return kept.length > 0 ? kept.join(" ") : question;
}

const citationSlugs = (result: unknown): Set<string> => {
  const cites = (result as { citations?: Array<{ page_slug?: string }> } | null)?.citations;
  const out = new Set<string>();
  if (Array.isArray(cites)) for (const c of cites) if (c?.page_slug) out.add(c.page_slug);
  return out;
};

const hitSlug = (h: unknown): string | undefined =>
  (h as { slug?: string; page_slug?: string })?.slug ?? (h as { page_slug?: string })?.page_slug;

export const PROFILE_REFUSAL = "refused: a profile is written only on that person's own turn";
export const SUPERSEDE_REFUSAL = "refused: supersedes must name a page in the same memory";
export const SELF_SUPERSEDE_REFUSAL = "refused: a page cannot supersede itself";
export const SAME_CALL_SUPERSEDE_REFUSAL = "refused: a page cannot supersede a page written in the same call";
export const LOCK_REFUSAL = "refused: in a /1on1, memory stays with this person; ask them before sharing it";

export type MemoizeTarget = "mine" | "shared" | "profile";
export interface KbMemoizeArgs {
  pages: Array<TypedPageInput & { summary: string }>;
  target?: MemoizeTarget;
  /** Slack user id the pages are about; with target "profile", the speaker. */
  subject?: string;
}

/**
 * The one person whose own turn this is: the turn's sole Slack sender, on an
 * interactive Slack-origin turn; else null. Never the live ctx's speaker: on
 * mono the ctx is whoever spoke last, and a queued job can hold merged
 * messages. Any other sender in the turn means nobody's own turn. Profile
 * writes and memory_about both key on it.
 */
function ownTurnSender(g: GateInput): TurnSender | null {
  if (g.userId === null || !g.interactive || g.origin !== "slack") return null;
  return soleSlackSender(g);
}

/**
 * The write scope for a kb_memoize target, or the refusal. Only `sourceId`
 * ever changes: the read union and client stay the turn's own.
 *
 * - profile: the SPEAKER's profile, only on their own Slack turn (a panel
 *   operator id is not a Slack id; cron never). A profile follows its person,
 *   so in someone else's /1on1 it is still the speaker's, never the owner's.
 * - in a /1on1 (invariant 1), only the lock owner's own slice: shared, the
 *   agent's slice and public would carry the thread out without that person.
 * - shared: the common KB, carded by the gate.
 * - mine: the turn's own slice as resolved.
 * The gate (classifyBrainOp) enforces the same rules again.
 */
function resolveMemoizeScope(target: MemoizeTarget, subject: string | undefined, base: BrainScope, g: GateInput): { scope: BrainScope; speaker?: string } | { error: string } {
  if (target === "profile") {
    const sender = ownTurnSender(g);
    const own = sender ? speakerProfileSource(sender.teamId, sender.userId) : null;
    if (!sender || own === null || (subject !== undefined && subject !== sender.userId)) {
      return { error: PROFILE_REFUSAL };
    }
    return { scope: { ...base, sourceId: own }, speaker: sender.userId };
  }
  const scope = target === "shared" ? { ...base, sourceId: SHARED_SOURCE } : base;
  if (g.lockedUser !== null) {
    if (g.userId !== g.lockedUser || scope.sourceId !== userSourceId(g.lockedUser)) return { error: LOCK_REFUSAL };
  }
  return { scope };
}

/** Which page types go where: a profile page only to the profile (slug
 *  "profile", one page), and the profile holds only profile and correction pages. */
function pageShapeError(pg: TypedPageInput, target: MemoizeTarget): string | null {
  if (target === "profile") {
    if (pg.type !== "profile" && pg.type !== "correction") return `refused: target "profile" takes pages of type profile or correction`;
    if (pg.type === "profile" && pg.slug !== "profile") return `refused: a profile page uses slug "profile"`;
    return null;
  }
  if (pg.type === "profile") return `refused: a type "profile" page goes to target "profile"`;
  return null;
}

export const THREAD_HISTORY_REFUSAL = "refused: no thread history is readable here";
export const THREAD_HISTORY_NO_SESSION = "refused: this thread's session is unknown, so its history cannot be read";
const THREAD_HISTORY_DEFAULT = 20;

/** Most characters one kb_thread_history call returns; the oldest turns drop first. */
export const THREAD_HISTORY_MAX_CHARS = 12000;

/** Most characters of the thread's summary kb_thread_history shows (part of THREAD_HISTORY_MAX_CHARS). */
export const THREAD_SUMMARY_MAX_CHARS = 4000;

/**
 * The thread's rolling summary (the quiet-moment pass) as the history's
 * opening lines, read from the conversation page's own source only; null when
 * there is none or it cannot be read (the history goes on without it).
 */
async function threadSummaryBlock(call: NonNullable<BrainToolDeps["call"]>, sessionId: string, read: BrainScope): Promise<string | null> {
  let rec: ReturnType<typeof readPageRecord> = null;
  try {
    rec = readPageRecord(await getPageOrNull(call, conversationSummarySlug(sessionId), { ...read, allowedSources: [read.sourceId] }));
  } catch {
    return null;
  }
  const body = rec?.body.trim();
  if (!body) return null;
  const cut = body.length <= THREAD_SUMMARY_MAX_CHARS ? body : body.slice(0, THREAD_SUMMARY_MAX_CHARS - 1) + "…";
  const through = rec!.meta.through ? ` through ${rec!.meta.through}` : "";
  return `[summary${through}] ${cut}
(turns follow)`;
}

/** One timeline row as `[date] who: text` lines (user, then assistant). The
 *  detail is `<user>U</user>\n<assistant>A</assistant>`; split at the first
 *  separator so a `</user>` inside U cannot cut the line. */
function threadHistoryLines(r: TimelineRow): string[] {
  const date = r.date ?? "undated";
  const detail = r.detail ?? "";
  const sep = "</user>\n<assistant>";
  const i = detail.indexOf(sep);
  if (detail.startsWith("<user>") && i >= 0 && detail.endsWith("</assistant>")) {
    const user = detail.slice("<user>".length, i);
    const assistant = detail.slice(i + sep.length, -"</assistant>".length);
    return [`[${date}] user: ${user.trim()}`, `[${date}] assistant: ${assistant.trim()}`];
  }
  return [`[${date}] note: ${(detail || r.summary).trim()}`];
}

/** The superseded page could not be tagged after the new page landed. */
class TrailError extends Error {}

export const MEMORY_ABOUT_REFUSAL = "refused: memory_about only answers for the person asking";

/** One page memory_about shows (spec §8.3 "what do you know about me?"). */
export interface MemoryEntry {
  where: "profile" | "agent" | "user" | "shared" | "public";
  slug: string;
  type: string;
  confidence: string;
  as_of: string;
  body: string;
}

const WHERE_ORDER: MemoryEntry["where"][] = ["profile", "user", "agent", "shared", "public"];
const WHERE_LABEL: Record<MemoryEntry["where"], string> = {
  profile: "their profile",
  user: "their /1on1 notes",
  agent: "the agent's notes",
  shared: "the team knowledge base",
  public: "the public notes",
};

/** One block per entry, profile first, then /1on1 notes, agent notes, team KB, public notes. Empty list → "". */
export function formatMemoryAbout(entries: MemoryEntry[]): string {
  const sorted = [...entries].sort((a, b) => WHERE_ORDER.indexOf(a.where) - WHERE_ORDER.indexOf(b.where));
  return sorted
    .map((e) => `[${e.confidence}] ${e.type}, from ${WHERE_LABEL[e.where]}, as of ${e.as_of} (slug ${e.slug})\n${e.body.trim()}`)
    .join("\n\n");
}

/** Page types that hold memory about a person (memory_about lists these). */
const ABOUT_TYPES = ["profile", "person-note", "correction", "team-fact"] as const;
/** Max pages of one type listed per source. */
const ABOUT_LIST_LIMIT = 500;

/**
 * The memory sources in what the turn reads, and the fixed slugs each holds
 * for a person's pages written before `subject` existed: the person's own
 * profile (only when it is the one in this scope; `profile`), and
 * `people/<userId>` in the agent's slices, their own `user-` slice (in the
 * scope only in their own /1on1), `shared` (plus the `shared/people/<userId>`
 * team fact) and `public`. KB sources are operator material and not read.
 */
function memorySources(scope: BrainScope, sender: TurnSender): Array<{ where: MemoryEntry["where"]; source: string; fixed: string[] }> {
  const out: Array<{ where: MemoryEntry["where"]; source: string; fixed: string[] }> = [];
  const profile = speakerProfileSource(sender.teamId, sender.userId);
  // gbrain stores slugs lowercased and reads them exactly, so the note for an
  // upper-case Slack id lives at its lowercased slug.
  const note = `people/${sender.userId}`.toLowerCase();
  for (const source of new Set(scope.allowedSources)) {
    if (source === profile) out.push({ where: "profile", source, fixed: ["profile"] });
    else if (source === userSourceId(sender.userId)) out.push({ where: "user", source, fixed: [note] });
    else if (source === AGENT_SOURCE || source.startsWith("agent-")) out.push({ where: "agent", source, fixed: [note] });
    else if (source === SHARED_SOURCE) out.push({ where: "shared", source, fixed: [note, `shared/${note}`] });
    else if (source === PUBLIC_SOURCE) out.push({ where: "public", source, fixed: [note] });
  }
  return out;
}

const rowSlugs = (rows: unknown): string[] =>
  Array.isArray(rows) ? rows.map((r) => (r as { slug?: unknown } | null)?.slug).filter((x): x is string => typeof x === "string") : [];

/**
 * Every page about the sender in what the turn reads. Per memory source, one
 * source at a time (each op limited to one source of the turn's read union,
 * so no new read path widens the scope): list the pages of each ABOUT_TYPES
 * type plus the fixed slugs, drop pages tagged superseded in that source, and
 * keep a page whose `subject` is the sender. A page with no `subject` is kept
 * only at a fixed slug or in the person's own profile source.
 */
async function collectMemoryAbout(call: NonNullable<BrainToolDeps["call"]>, scope: BrainScope, sender: TurnSender): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for (const m of memorySources(scope, sender)) {
    const only: BrainScope = { ...scope, sourceId: m.source, allowedSources: [m.source] };
    const listed = new Set<string>();
    for (const type of ABOUT_TYPES) {
      for (const slug of rowSlugs(await call("list_pages", { type, limit: ABOUT_LIST_LIMIT }, only))) listed.add(slug);
    }
    const slugs = [...new Set([...m.fixed, ...listed])];
    const tagged = await supersededSlugs(call, scope, [m.source]);
    for (const slug of slugs) {
      if (tagged.has(slug)) continue;
      const pg = readPageRecord(await getPageOrNull(call, slug, only));
      if (!pg || pg.superseded) continue;
      const subject = pg.meta.subject;
      if (subject !== undefined ? subject !== sender.userId : !(m.fixed.includes(slug) || m.where === "profile")) continue;
      entries.push({
        where: m.where,
        slug,
        type: pg.meta.type ?? "untyped",
        // A page with no confidence is the agent's own record unless it is in
        // the person's profile: inferred, except in the profile.
        confidence: pg.meta.confidence ?? (m.where === "profile" ? "told" : "inferred"),
        as_of: pg.meta.as_of ?? "unknown",
        body: pg.body,
      });
    }
  }
  return entries;
}

export const brainHandlers = {
  kb_think: async (p: { question: string }, d: BrainToolDeps): Promise<ToolResult> => {
    try {
      // SDK-routed synthesis (subscription auth) — not the raw think op.
      const think = d.think ?? brainThink;
      const result = await think(p.question, await d.scope());
      // Mode B / B′ guard: kb_think's hybrid gather can rank a present,
      // well-titled page below noisier neighbors and then synthesize a
      // confident answer that cites the wrong pages (or none). Always
      // cross-check with a distilled keyword search and surface any strong hit
      // the synthesis did NOT cite — so a present page is never silently
      // dropped, whether the answer was empty or just off-target.
      // See docs/findings/2026-06-14-brain-memoize-failure.md.
      try {
        // Per-source cross-check (gather), not a single pooled search: the
        // pooled search is the very thing a bulk corpus floods, so the fallback
        // used to surface more junk instead of the present page. gather()
        // guarantees curated sources their own slots, so a strong uncited hit
        // (e.g. the curated page kb_think's gather missed) actually shows up here.
        const hits = await gather(distillQuery(p.question), await d.scope(), { finalLimit: 5, call: d.call });
        if (Array.isArray(hits) && hits.length > 0) {
          const cited = citationSlugs(result);
          const missed = hits.filter((h) => {
            const s = hitSlug(h);
            return s !== undefined && !cited.has(s);
          });
          if (missed.length > 0) {
            // If runThink gathered nothing, attempt rescue synthesis from the
            // fallback pages. runThink uses gbrain's pooled search (sourceId-
            // anchored) which consistently misses pages in other agent slices
            // even when gather()'s per-source fan-out finds them fine.
            // See docs/findings/2026-07-27-kb-think-gather-miss.md.
            const pagesGathered = (result as { pagesGathered?: number }).pagesGathered ?? -1;
            if (pagesGathered === 0) {
              try {
                const rescued = await synthesizeFromHits(p.question, missed, sdkThinkClient());
                if (rescued) return asJson({ ...rescued, gather_rescue: true });
              } catch (synthErr) {
                console.warn("[brain] kb_think rescue synthesis failed:", synthErr instanceof Error ? synthErr.message : String(synthErr));
              }
            }
            return asJson({ ...(result as object), search_fallback: missed });
          }
        }
      } catch (crossCheckErr) {
        console.warn("[brain] kb_think cross-check failed:", crossCheckErr instanceof Error ? crossCheckErr.message : String(crossCheckErr));
      }
      return asJson(result);
    } catch (e) {
      return err(humanizeBrainError("think", e));
    }
  },
  kb_search: async (p: { query: string; limit?: number }, d: BrainToolDeps): Promise<ToolResult> => {
    // Per-source gather instead of gbrain's single pooled search, so a curated
    // page is never crowded out of the candidate set by a high-volume source
    // (a bulk auto-generated corpus). See src/knowledge/gather.ts.
    try {
      const hits = await gather(p.query, await d.scope(), { finalLimit: p.limit ?? 20, call: d.call });
      return asJson(hits);
    } catch (e) {
      return err(humanizeBrainError("search", e));
    }
  },
  kb_get_page: (p: { slug: string }, d: BrainToolDeps) => runRead("get_page", { slug: p.slug }, d),
  kb_list_pages: (p: { type?: string; tag?: string; limit?: number }, d: BrainToolDeps) =>
    runRead("list_pages", { ...p }, d),
  kb_graph: async (p: { slug: string }, d: BrainToolDeps): Promise<ToolResult> => {
    const links = await runRead("get_links", { slug: p.slug }, d);
    if (links.isError) return links;
    const back = await runRead("get_backlinks", { slug: p.slug }, d);
    if (back.isError) return back;
    return ok(JSON.stringify({
      links: JSON.parse(links.content[0]!.text),
      backlinks: JSON.parse(back.content[0]!.text),
    }, null, 2));
  },
  kb_memoize: async (p: KbMemoizeArgs, d: BrainToolDeps): Promise<ToolResult> => {
    if (!Array.isArray(p.pages) || p.pages.length === 0) {
      return err("kb_memoize requires at least one page");
    }
    // gbrain stores a page under its lowercased slug, then chunks it under the
    // slug as given, so a mixed-case slug fails with "Page not found" after the
    // page row is written. Slack ids are upper case and person-notes live at
    // `people/<userId>`, so a live run hit this on its first person-note.
    const lower = (s: string | undefined) => (typeof s === "string" ? s.toLowerCase() : s);
    const pages = p.pages.map((pg) => ({ ...pg, slug: lower(pg.slug)!, supersedes: lower(pg.supersedes) }));
    if (pages.length > KB_MEMOIZE_MAX_PAGES) {
      return err(`kb_memoize accepts at most ${KB_MEMOIZE_MAX_PAGES} pages per call (got ${pages.length})`);
    }
    // C1: settle the agent identity before resolving the write scope, so a write
    // in the boot window (before auth.test lands) targets the real `agent-<id>`
    // slice, not `agent-default`. No-op once resolved; never hangs (falls back).
    await agentIdReady();
    const target = p.target ?? "mine";
    const gate = await d.gate();
    const resolved = resolveMemoizeScope(target, p.subject, await d.scope(), gate);
    if ("error" in resolved) return err(resolved.error);
    const { scope, speaker } = resolved;
    // A profile rewrite keeps the fields it does not set. Ping preferences
    // (mutes from a "stop" reply, opt-ins, quiet hours) live there, and a live
    // model rewrote the page with only a new name, dropping its mutes.
    const isProfile = (pg: TypedPageInput) => target === "profile" && pg.slug === "profile" && pg.type === "profile";
    let kept: Record<string, string> = {};
    if (pages.some(isProfile)) {
      const rec = readPageRecord(await getPageOrNull(d.call ?? brainCall, "profile", { ...scope, allowedSources: [scope.sourceId] }));
      if (rec && !rec.superseded) kept = carriedFields(rec.meta);
    }
    // Compose every page before anything is written: one refusal stops the batch.
    const now = new Date();
    const composed: Array<{ slug: string; content: string; supersedes?: string }> = [];
    for (const pg of pages) {
      const shape = pageShapeError(pg, target);
      if (shape) return err(shape);
      const source = pg.source ?? (speaker !== undefined ? `told by ${speaker}` : undefined);
      // A page's own subject wins; the call's subject fills pages without one
      // (a profile's is its speaker), so memory_about finds a person's pages
      // under any slug and a batch about two people stamps each one right.
      // An untyped page keeps its own subject, which composePage refuses.
      const subject = pg.subject ?? (pg.type !== undefined ? (p.subject ?? speaker) : undefined);
      if (target === "profile" && subject !== speaker) return err(PROFILE_REFUSAL);
      const { subject: _own, ...own } = pg;
      const page = isProfile(pg) && Object.keys(kept).length > 0 ? { ...own, fields: { ...kept, ...(own.fields ?? {}) } } : own;
      const c = composePage({ ...page, ...(source !== undefined ? { source } : {}), ...(subject !== undefined ? { subject } : {}) }, now);
      if ("error" in c) return err(c.error);
      composed.push({ slug: pg.slug, content: c.content, ...(pg.supersedes !== undefined ? { supersedes: pg.supersedes } : {}) });
    }
    const label = `→ ${target}`;
    const retired = composed.filter((pg) => pg.supersedes !== undefined).map((pg) => pg.supersedes!);
    // A page never retires itself or a page this same call writes: the
    // written page would end up tagged superseded.
    const writing = new Set(composed.map((pg) => pg.slug));
    for (const pg of composed) {
      if (pg.supersedes === pg.slug) return err(SELF_SUPERSEDE_REFUSAL);
      if (pg.supersedes !== undefined && writing.has(pg.supersedes)) return err(SAME_CALL_SUPERSEDE_REFUSAL);
    }
    const trail = retired.length > 0 ? ` (and tags ${retired.join(", ")} as ${SUPERSEDED_TAG})` : "";
    const describe = pages.length === 1
      ? `KB write ${label}: ${pages[0]!.slug} — ${pages[0]!.summary}${trail}`
      : `KB write ${label}: ${pages.length} pages — ${pages.map((pg) => pg.slug).join(", ")}${trail}`;
    try {
      const call = d.call ?? brainCall;
      // Supersede check, before any write: the older page must exist in the
      // WRITE source itself (a read limited to it), so a page can only retire
      // one in the same memory, never one it merely reads.
      const inWriteSource: BrainScope = { ...scope, allowedSources: [scope.sourceId] };
      const checked = new Set<string>();
      for (const slug of retired) {
        if (checked.has(slug)) continue;
        if (!(await getPageOrNull(call, slug, inWriteSource))) return err(SUPERSEDE_REFUSAL);
        checked.add(slug);
      }
      // One approval gates the whole batch; the gated thunk writes every page,
      // then tags each superseded page (left as written otherwise). Each
      // write goes through brainCall, which ensures scope.sourceId exists
      // first (see docs/findings/2026-06-14-brain-memoize-failure.md).
      const r = await gatedBrainCall("put_page", {
        scope,
        gate,
        managers: d.managers(),
        requestApproval: d.requestApproval,
        call: async () => {
          // A page written again is current: drop a superseded tag it carries
          // (in this source), so readers that filter on the tag see it again.
          // Read after the approval, before the first write.
          const tagged = await supersededSlugs(call, scope, [scope.sourceId]);
          const revived = composed.map((pg) => pg.slug).filter((slug) => tagged.has(slug));
          const results: unknown[] = [];
          for (const pg of composed) {
            results.push(await call("put_page", { slug: pg.slug, content: pg.content }, scope));
          }
          for (const slug of revived) {
            try {
              results.push(await call("remove_tag", { slug, tag: SUPERSEDED_TAG }, scope));
            } catch (e) {
              throw new TrailError(
                `kb_memoize wrote ${slug}, but removing its ${SUPERSEDED_TAG} tag failed (${e instanceof Error ? e.message : String(e)}); readers still treat it as superseded. Retry the same kb_memoize call.`,
              );
            }
          }
          for (const pg of composed) {
            if (pg.supersedes === undefined) continue;
            try {
              results.push(await call("add_tag", { slug: pg.supersedes, tag: SUPERSEDED_TAG }, scope));
            } catch (e) {
              throw new TrailError(
                `kb_memoize wrote ${pg.slug}, but tagging ${pg.supersedes} as ${SUPERSEDED_TAG} failed (${e instanceof Error ? e.message : String(e)}). ${pg.slug} already says it supersedes ${pg.supersedes}; retry kb_memoize for ${pg.slug} with the same supersedes to finish the trail.`,
              );
            }
          }
          return results;
        },
        describe,
      });
      if (!r.ok) return err(r.reason);
      if (d.onWritten) {
        try {
          await d.onWritten(composed.map((pg) => ({ slug: pg.slug, content: pg.content, source: scope.sourceId })), scope);
        } catch (e) {
          console.error(`[brain] kb_memoize: post-write hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return asJson({ written: composed.map((pg) => pg.slug), target, ...(retired.length > 0 ? { superseded: retired } : {}), results: r.result });
    } catch (e) {
      if (e instanceof TrailError) return err(e.message);
      return err(humanizeBrainError("put_page", e));
    }
  },
  memory_about: async (p: { userId: string }, d: BrainToolDeps): Promise<ToolResult> => {
    // Only for the one person whose own turn this is (the turn's senders, not
    // the live ctx, which on mono flips to whoever posted mid-turn): one
    // person's memory never shows inside another person's turn.
    const sender = ownTurnSender(await d.gate());
    if (!sender || sender.userId !== p.userId) return err(MEMORY_ABOUT_REFUSAL);
    try {
      const entries = await collectMemoryAbout(d.call ?? brainCall, await d.scope(), sender);
      return ok(entries.length > 0 ? formatMemoryAbout(entries) : `Nothing is recorded about ${p.userId} in what this turn can read.`);
    } catch (e) {
      return err(humanizeBrainError("memory_about", e));
    }
  },
  kb_thread_history: async (p: { limit?: number; before?: string }, d: BrainToolDeps): Promise<ToolResult> => {
    const t = await d.thread?.();
    if (!t?.sessionId) return err(THREAD_HISTORY_NO_SESSION);
    if (!t.read) return err(THREAD_HISTORY_REFUSAL);
    try {
      const raw = (await (d.call ?? brainCall)("get_timeline", { slug: conversationSlug(t.sessionId) }, t.read)) as TimelineRow[] | null;
      // A row without an id is keyed by its position, so paging stays consistent.
      let rows = orderTimeline(raw ?? []).map((r, i) => ({ r, id: r.id ?? i + 1 }));
      if (p.before !== undefined) {
        if (!/^\d+$/.test(p.before)) return err("kb_thread_history: before must be an entry id from the footer of a previous call");
        const before = Number(p.before);
        rows = rows.filter((x) => x.id < before);
      }
      // The first page opens with the thread's summary, inside the same cap.
      const summary = p.before === undefined ? await threadSummaryBlock(d.call ?? brainCall, t.sessionId, t.read) : null;
      if (rows.length === 0) return ok(summary ?? "No earlier turns are recorded for this thread.");
      const limit = Math.min(Math.max(Math.trunc(p.limit ?? THREAD_HISTORY_DEFAULT), 1), 50);
      // Newest first until the cap, then printed oldest-first.
      const picked: string[][] = [];
      let used = summary ? summary.length + 1 : 0;
      let capped = false;
      let oldestId = rows[rows.length - 1]!.id;
      for (const x of rows.slice(-limit).reverse()) {
        const ls = threadHistoryLines(x.r);
        const size = ls.reduce((n, l) => n + l.length + 1, 0);
        if (picked.length > 0 && used + size > THREAD_HISTORY_MAX_CHARS) {
          capped = true;
          break;
        }
        picked.push(ls);
        used += size;
        oldestId = x.id;
      }
      const out = [...(summary ? [summary] : []), ...picked.reverse().flat()];
      const remaining = rows.length - picked.length;
      if (remaining > 0) {
        out.push(`(${remaining} older turns remain${capped ? `; output capped at ${THREAD_HISTORY_MAX_CHARS} characters, oldest dropped` : ""}; pass before: "${oldestId}")`);
      }
      return ok(out.join("\n"));
    } catch (e) {
      return err(humanizeBrainError("kb_thread_history", e));
    }
  },
  kb_delete_page: (p: { slug: string; reason: string }, d: BrainToolDeps) =>
    runGated("delete_page", { slug: p.slug }, `KB delete: ${p.slug} — ${p.reason}`, d),
};

/** `kbs`: the session persona's readable KBs, resolved per call (personaKbs);
 *  default every installed KB. */
export function createKbMcp(deps?: BrainToolDeps, opts: { kbs?: () => KbEntry[] } = {}): McpSdkServerConfigWithInstance {
  const kbs = opts.kbs ?? loadKbs;
  const c = kbContract.tools;
  const brainTools = deps && brainEnabled()
    ? [
        tool(c.kb_think.name, c.kb_think.description, c.kb_think.schema,
          (a: { question: string }) => brainHandlers.kb_think(a, deps)),
        tool(c.kb_search.name, c.kb_search.description, c.kb_search.schema,
          (a: { query: string; limit?: number }) => brainHandlers.kb_search(a, deps)),
        tool(c.kb_get_page.name, c.kb_get_page.description, c.kb_get_page.schema,
          (a: { slug: string }) => brainHandlers.kb_get_page(a, deps)),
        tool(c.kb_list_pages.name, c.kb_list_pages.description, c.kb_list_pages.schema,
          (a: { type?: string; tag?: string; limit?: number }) => brainHandlers.kb_list_pages(a, deps)),
        tool(c.kb_graph.name, c.kb_graph.description, c.kb_graph.schema,
          (a: { slug: string }) => brainHandlers.kb_graph(a, deps)),
        tool(c.kb_memoize.name, c.kb_memoize.description, c.kb_memoize.schema,
          (a: KbMemoizeArgs) => brainHandlers.kb_memoize(a, deps)),
        tool(c.memory_about.name, c.memory_about.description, c.memory_about.schema,
          (a: { userId: string }) => brainHandlers.memory_about(a, deps)),
        tool(c.kb_thread_history.name, c.kb_thread_history.description, c.kb_thread_history.schema,
          (a: { limit?: number; before?: string }) => brainHandlers.kb_thread_history(a, deps)),
        tool(c.kb_delete_page.name, c.kb_delete_page.description, c.kb_delete_page.schema,
          (a: { slug: string; reason: string }) => brainHandlers.kb_delete_page(a, deps)),
      ]
    : [];

  return createSdkMcpServer({
    name: KB_MCP_NAME,
    version: "0.2.0",
    tools: [
      ...brainTools,
      tool(c.list_kbs.name, c.list_kbs.description, c.list_kbs.schema, () => kbHandlers.list_kbs(kbs())),
      tool(c.search_kbs.name, c.search_kbs.description, c.search_kbs.schema,
        (a: { query: string; limit?: number }) => kbHandlers.search_kbs(a, kbs())),
    ],
  });
}
