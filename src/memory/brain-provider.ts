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
  #ready: Promise<void> | null = null;
  #pagesEnsured = new Set<string>();

  constructor(deps: { call?: BrainOpCall } = {}) {
    this.#call = deps.call ?? brainCall;
  }

  #slug(sessionId: string): string {
    return `conversations/${sessionId.toLowerCase()}`;
  }

  #ensureReady(): Promise<void> {
    // Resolve the agent identity before the first write so memory never lands
    // in `agent-default` and then splits off to `agent-<id>` once auth.test settles.
    return (this.#ready ??= agentIdReady().then(() => ensureSources()));
  }

  async #ensurePage(sessionId: string): Promise<string> {
    const slug = this.#slug(sessionId);
    if (this.#pagesEnsured.has(slug)) return slug;
    let existing: unknown = null;
    try {
      existing = await this.#call("get_page", { slug }, agentScope());
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
        agentScope(),
      );
    }
    this.#pagesEnsured.add(slug);
    return slug;
  }

  async prefetch(sessionId: string): Promise<string | null> {
    try {
      await this.#ensureReady();
      const rows = (await this.#call("get_timeline", { slug: this.#slug(sessionId) }, agentScope())) as TimelineRow[] | null;
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

  async syncTurn(t: SyncTurn): Promise<void> {
    try {
      await this.#ensureReady();
      const slug = await this.#ensurePage(t.sessionId);
      await this.#call(
        "add_timeline_entry",
        {
          slug,
          date: new Date().toISOString().slice(0, 10),
          source: "slack-turn",
          summary: truncate(t.user, 200),
          detail: `<user>${truncate(t.user, 800)}</user>\n<assistant>${truncate(t.assistant, 800)}</assistant>`,
        },
        agentScope(),
      );
    } catch (e) {
      console.error("[brain-memory] syncTurn failed:", e instanceof Error ? e.message : e);
    }
  }
}
