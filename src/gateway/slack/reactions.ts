import type { WebClientLike } from "../core/transport";

/**
 * Track one "status reaction" per inbound message so we can transition the
 * emoji as the session progresses (👀 received → ⚙️ working → ✅ done / ❌ error).
 *
 * Accepts either a fixed client (single-bot mode) or a per-session resolver so
 * named personas can react using their own xoxp token while the default bot
 * is the fallback. Resolver is called lazily on each `set()` — no init-order risk.
 */
export class ReactionTracker {
  #clientOrResolver: WebClientLike | ((sessionId: string) => WebClientLike);
  #current = new Map<string, { channel: string; ts: string; emoji: string }>();
  #disabled = false;

  constructor(clientOrResolver: WebClientLike | ((sessionId: string) => WebClientLike)) {
    this.#clientOrResolver = clientOrResolver;
  }

  #clientFor(sessionId: string): WebClientLike {
    return typeof this.#clientOrResolver === "function"
      ? this.#clientOrResolver(sessionId)
      : this.#clientOrResolver;
  }

  async set(sessionId: string, channel: string, ts: string, emoji: string) {
    if (this.#disabled) return;
    const client = this.#clientFor(sessionId);
    const prev = this.#current.get(sessionId);
    if (prev?.emoji === emoji) return;
    if (prev) {
      try {
        await client.reactions.remove({
          channel: prev.channel,
          timestamp: prev.ts,
          name: prev.emoji,
        });
      } catch {
        // tolerate already-removed / not-reacted
      }
    }
    try {
      await client.reactions.add({ channel, timestamp: ts, name: emoji });
      this.#current.set(sessionId, { channel, ts, emoji });
    } catch (e: any) {
      const code = e?.data?.error ?? e?.message;
      if (code === "already_reacted") {
        this.#current.set(sessionId, { channel, ts, emoji });
        return;
      }
      const needed = e?.data?.needed;
      const provided = e?.data?.provided;
      console.error("[reactions] add failed:", code, { needed, provided });
      if (code === "missing_scope" || code === "not_allowed_token_type") {
        this.#disabled = true;
        console.log("[reactions] auto-disabled — reinstall app w/ reactions:write scope");
      }
    }
  }

  forget(sessionId: string) {
    this.#current.delete(sessionId);
  }
}
