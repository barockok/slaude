import type { WebClient } from "@slack/web-api";

/**
 * Bot-level presence: profile status + emoji while at least one session is busy.
 * Slack profile is shared across all threads so we ref-count active sessions.
 *
 * `users.profile.set` requires a user token (xoxp); bot tokens get
 * `not_allowed_token_type`. If `SLACK_USER_TOKEN` is set we use a separate
 * WebClient with that token; otherwise this becomes a no-op (logged once).
 */
export class Presence {
  #client: WebClient | null;
  #activeSessions = new Set<string>();
  #lastApplied: { text: string; emoji: string } | null = null;
  #disabled = false;

  constructor(botClient: WebClient) {
    const userToken = process.env.SLACK_USER_TOKEN;
    if (userToken) {
      // Lazy import to avoid pulling WebClient when not needed.
      const { WebClient: WC } = require("@slack/web-api");
      this.#client = new WC(userToken);
    } else {
      this.#client = null;
      this.#disabled = true;
      console.log("[presence] disabled — set SLACK_USER_TOKEN (xoxp) to enable status updates");
    }
    void botClient; // unused; kept for API compat
  }

  enter(sessionId: string, label: { text: string; emoji: string }) {
    if (this.#disabled) return;
    this.#activeSessions.add(sessionId);
    this.#apply(label).catch((e) => this.#fail("set", e));
  }

  exit(sessionId: string) {
    if (this.#disabled) return;
    this.#activeSessions.delete(sessionId);
    if (this.#activeSessions.size === 0) {
      this.#apply({ text: "", emoji: "" }).catch((e) => this.#fail("clear", e));
    }
  }

  #fail(op: string, e: any) {
    const code = e?.data?.error ?? e?.code ?? e?.message;
    console.error(`[presence] ${op} failed: ${code}`);
    if (code === "not_allowed_token_type" || code === "missing_scope") {
      this.#disabled = true;
      console.log("[presence] auto-disabled after auth/scope failure");
    }
  }

  async #apply(label: { text: string; emoji: string }) {
    if (!this.#client) return;
    if (
      this.#lastApplied &&
      this.#lastApplied.text === label.text &&
      this.#lastApplied.emoji === label.emoji
    ) {
      return;
    }
    this.#lastApplied = label;
    await this.#client.users.profile.set({
      profile: {
        status_text: label.text,
        status_emoji: label.emoji,
        status_expiration: 0,
      },
    } as any);
  }
}
