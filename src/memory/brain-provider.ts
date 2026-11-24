import { stripTurnMemoryContext, type MemoryProvider, type SyncTurn } from "./provider";
import { truncate } from "./sqlite-provider";
import { brainCall, ensureSources } from "../knowledge/brain";
import { agentIdReady, agentScope } from "../knowledge/agent-identity";
import type { BrainScope } from "../knowledge/scope";
import { hasPlacePrefix } from "./place-id";

/**
 * Brain-backed memory: each session gets a conversation page in the agent's
 * own per-agent source; turns append as timeline entries (rows — no page
 * rewrite, no page_versions bloat). The nightly cycle can later mine these
 * pages into facts/takes. Episodic memory lives where semantic memory will.
 *
 * Failure policy: memory must never break a turn — prefetch degrades to null,
 * syncTurn to a logged no-op.
 */

export type TimelineRow = { id?: number; date: string; summary: string; detail?: string | null };
type BrainOpCall = (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;

/** The page a session's turns are appended to. */
export const conversationSlug = (sessionId: string): string => `conversations/${sessionId.toLowerCase()}`;

/** A session's rolling summary (the quiet-moment pass), beside its conversation page in the same source. */
export const conversationSummarySlug = (sessionId: string): string => `${conversationSlug(sessionId)}/summary`;

/** Timeline rows in write order (by id). */
export const orderTimeline = (rows: TimelineRow[]): TimelineRow[] => [...rows].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

/**
 * A session's timeline rows from the scope's read sources. A scope whose write source is a place (memory places
 * on, rc.47) is read place first and then the persona's slice, because a session that began before the switch keeps
 * its earlier turns there: the older slice's rows come first and the place's after them, ids renumbered so paging
 * by id stays consistent. Any other scope is one call, as before.
 */
export async function readTimeline(call: BrainOpCall, slug: string, scope: BrainScope): Promise<TimelineRow[] | null> {
  if (!hasPlacePrefix(scope.sourceId) || scope.allowedSources.length < 2) return (await call("get_timeline", { slug }, scope)) as TimelineRow[] | null;
  const [head, ...rest] = scope.allowedSources;
  const narrow = (sources: string[]): BrainScope => ({ ...scope, sourceId: sources[0]!, allowedSources: sources });
  const here = ((await call("get_timeline", { slug }, narrow([head!]))) as TimelineRow[] | null) ?? [];
  const older: TimelineRow[] = [];
  for (const source of rest) {
    if (hasPlacePrefix(source)) continue;
    const rows = ((await call("get_timeline", { slug }, narrow([source]))) as TimelineRow[] | null) ?? [];
    older.push(...orderTimeline(rows));
    // The first slice that holds the page is the session's earlier home; the persona's legacy source follows it.
    if (rows.length > 0) break;
  }
  // A turn the move job copied into the place is held by both slices: it shows once, from the place.
  const key = (r: TimelineRow): string => `${r.date}\u0000${r.summary}\u0000${r.detail ?? ""}`;
  const held = new Set(here.map(key));
  const merged = [...older.filter((r) => !held.has(key(r))), ...orderTimeline(here)].map((r, i) => ({ ...r, id: i + 1 }));
  return merged.length > 0 ? merged : null;
}

export class BrainMemoryProvider implements MemoryProvider {
  /** How many recent turns to surface in <memory-context>. */
  recentTurnLimit = 5;

  #call: BrainOpCall;
  #readyFn: () => Promise<void>;
  #ready: Promise<void> | null = null;
  #pagesEnsured = new Set<string>();

  /** `ready` is injectable for tests that fake the brain (default: resolve the
   *  agent identity, then ensure the baseline sources). */
  constructor(deps: { call?: BrainOpCall; ready?: () => Promise<void> } = {}) {
    this.#call = deps.call ?? brainCall;
    // Resolve the agent identity before the first write so memory never lands
    // in `agent-default` and then splits off to `agent-<id>` once auth.test settles.
    this.#readyFn = deps.ready ?? (() => agentIdReady().then(() => ensureSources()));
  }

  #slug(sessionId: string): string {
    return conversationSlug(sessionId);
  }

  #ensureReady(): Promise<void> {
    return (this.#ready ??= this.#readyFn());
  }

  async #ensurePage(sessionId: string, scope: BrainScope): Promise<string> {
    const slug = this.#slug(sessionId);
    // Keyed per source: one session can write into two slices (the agent's
    // mind, then the user's once a /1on1 lock is taken).
    const key = `${scope.sourceId}\u0000${slug}`;
    if (this.#pagesEnsured.has(key)) return slug;
    let existing: unknown = null;
    try {
      existing = await this.#call("get_page", { slug }, scope);
    } catch (e) {
      // get_page throws OperationError(code=page_not_found) for missing pages.
      if ((e as { code?: string }).code !== "page_not_found") throw e;
    }
    if (!existing) {
      await this.#call(
        "put_page",
        {
          slug,
          content: `---\ntype: conversation\n---\n# Conversation ${sessionId}\n\nSlack session transcript timeline. Turns live in the Timeline section.\n`,
        },
        scope,
      );
    }
    this.#pagesEnsured.add(key);
    return slug;
  }

  /** UNSCOPED: the process-wide agent identity's slice. No turn path uses it:
   *  mono installs makeScopedMemory (src/memory/scoped.ts) and nodes call the
   *  gateway's routes, both of which use prefetchIn/syncTurnIn. */
  prefetch(sessionId: string): Promise<string | null> {
    return this.prefetchIn(sessionId, agentScope());
  }

  syncTurn(t: SyncTurn): Promise<void> {
    return this.syncTurnIn(t, agentScope());
  }

  /** Read the session's recent turns in an explicit scope: the gateway's memory
   *  route derives it from the verified job token (src/memory/scope.ts). */
  async prefetchIn(sessionId: string, scope: BrainScope): Promise<string | null> {
    try {
      await this.#ensureReady();
      const rows = await readTimeline(this.#call, this.#slug(sessionId), scope);
      if (!rows || rows.length === 0) return null;
      const ordered = orderTimeline(rows);
      const recent = ordered.slice(-this.recentTurnLimit);
      const lines = ["<recent-turns>"];
      for (const r of recent) lines.push(r.detail || r.summary);
      lines.push("</recent-turns>");
      return lines.join("\n");
    } catch (e) {
      console.error("[brain-memory] prefetch failed:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** Append the turn to the session's conversation page in an explicit scope. */
  async syncTurnIn(t: SyncTurn, scope: BrainScope): Promise<void> {
    // Again here for an older node whose manager sent the block.
    t = { ...t, user: stripTurnMemoryContext(t.user) };
    try {
      await this.#ensureReady();
      const slug = await this.#ensurePage(t.sessionId, scope);
      await this.#call(
        "add_timeline_entry",
        {
          slug,
          date: new Date().toISOString().slice(0, 10),
          source: "slack-turn",
          summary: truncate(t.user, 200),
          detail: `<user>${truncate(t.user, 800)}</user>\n<assistant>${truncate(t.assistant, 800)}</assistant>`,
        },
        scope,
      );
    } catch (e) {
      console.error("[brain-memory] syncTurn failed:", e instanceof Error ? e.message : e);
    }
  }
}
