import type { WebClient } from "@slack/web-api";

/**
 * Bot-level presence: profile status + emoji while at least one session is busy.
 * Slack profile is shared across all threads so we ref-count active sessions.
 */
export class Presence {
  #client: WebClient;
  #activeSessions = new Set<string>();
  #lastApplied: { text: string; emoji: string } | null = null;

  constructor(client: WebClient) {
    this.#client = client;
  }

  enter(sessionId: string, label: { text: string; emoji: string }) {
    this.#activeSessions.add(sessionId);
    this.#apply(label).catch((e) => console.error("[presence] set failed:", e));
  }

  exit(sessionId: string) {
    this.#activeSessions.delete(sessionId);
    if (this.#activeSessions.size === 0) {
      this.#apply({ text: "", emoji: "" }).catch((e) =>
        console.error("[presence] clear failed:", e),
      );
    }
  }

  async #apply(label: { text: string; emoji: string }) {
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
