import type { WebClient } from "@slack/web-api";

/**
 * Track one "status reaction" per inbound message so we can transition the
 * emoji as the session progresses (👀 received → ⚙️ working → ✅ done / ❌ error).
 */
export class ReactionTracker {
  #client: WebClient;
  #current = new Map<string, { channel: string; ts: string; emoji: string }>();

  constructor(client: WebClient) {
    this.#client = client;
  }

  async set(sessionId: string, channel: string, ts: string, emoji: string) {
    const prev = this.#current.get(sessionId);
    if (prev?.emoji === emoji) return;
    if (prev) {
      try {
        await this.#client.reactions.remove({
          channel: prev.channel,
          timestamp: prev.ts,
          name: prev.emoji,
        });
      } catch {
        // tolerate already-removed / not-reacted
      }
    }
    try {
      await this.#client.reactions.add({ channel, timestamp: ts, name: emoji });
      this.#current.set(sessionId, { channel, ts, emoji });
    } catch (e: any) {
      // Tolerate already_reacted (e.g., on re-entry after restart).
      if (e?.data?.error !== "already_reacted") {
        console.error("[reactions] add failed:", e?.data?.error ?? e);
      } else {
        this.#current.set(sessionId, { channel, ts, emoji });
      }
    }
  }

  forget(sessionId: string) {
    this.#current.delete(sessionId);
  }
}
