import type { MemoryProvider, SyncTurn } from "./provider";
import { truncate } from "./sqlite-provider";
import { brainCall, ensureSources } from "../knowledge/brain";
import { agentIdReady, agentScope } from "../knowledge/agent-identity";
import type { BrainScope } from "../knowledge/scope";

/**
 * Brain-backed memory: each session gets a conversation page in the agent's
 * own per-agent source; turns append as timeline entries (rows — no page
 * rewrite, no page_versions bloat). The nightly cycle can later mine these
 * pages into facts/takes. Episodic memory lives where semantic memory will.
 *
 * Failure policy: memory must never break a turn — prefetch degrades to null,
 * syncTurn to a logged no-op.
 */

type TimelineRow = { id?: number; date: string; summary: string; detail?: string | null };
type BrainOpCall = (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;

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
    return `conversations/${sessionId.toLowerCase()}`;
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
      const rows = (await this.#call("get_timeline", { slug: this.#slug(sessionId) }, scope)) as TimelineRow[] | null;
      if (!rows || rows.length === 0) return null;
      const ordered = [...rows].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
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
