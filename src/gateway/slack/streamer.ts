import type { WebClient } from "@slack/web-api";
import { mdToMrkdwn, SLACK_MAX_TEXT } from "./format";

/**
 * Per-session live-edit streamer.
 *
 * One Slack message per session that grows as assistant text streams in.
 * When the buffer exceeds the chat.update cap, we seal the current message
 * and open a fresh one. Updates are debounced so we don't burn rate limit
 * on every token chunk.
 *
 * Usage:
 *   const s = new Streamer(client, channel, threadTs);
 *   s.append("hello");
 *   s.append(" world");
 *   await s.flush();   // call on turn-end
 *   s.close();         // call when session goes idle
 */
export class Streamer {
  #client: WebClient;
  #channel: string;
  #threadTs: string;
  #buffer = "";
  #current: { ts: string; text: string } | null = null;
  #updateTimer: ReturnType<typeof setTimeout> | null = null;
  #updateInflight = false;
  #pendingFlush = false;

  /** Soft cap below the hard 39k limit; leaves room for the live cursor. */
  static SEAL_AT = 36000;
  /** Min ms between chat.update calls per message. */
  static UPDATE_INTERVAL_MS = 700;
  /** Suffix appended while streaming so users see it's live. */
  static CURSOR = " ▍";

  constructor(client: WebClient, channel: string, threadTs: string) {
    this.#client = client;
    this.#channel = channel;
    this.#threadTs = threadTs;
  }

  append(text: string) {
    if (!text) return;
    this.#buffer += text;
    this.#scheduleUpdate();
  }

  /** Force a final update (no cursor) and seal the message. Call on done/error. */
  async flush() {
    this.#pendingFlush = true;
    if (this.#updateTimer) {
      clearTimeout(this.#updateTimer);
      this.#updateTimer = null;
    }
    await this.#sync(/*final*/ true);
  }

  /** End of session — drop the cursor on whatever is currently displayed. */
  async close() {
    await this.flush();
    this.#current = null;
    this.#buffer = "";
  }

  #scheduleUpdate() {
    if (this.#updateTimer) return;
    this.#updateTimer = setTimeout(() => {
      this.#updateTimer = null;
      void this.#sync(false);
    }, Streamer.UPDATE_INTERVAL_MS);
  }

  async #sync(final: boolean) {
    if (this.#updateInflight) {
      // Re-arm so the trailing buffer still gets pushed.
      if (!final) this.#scheduleUpdate();
      return;
    }
    this.#updateInflight = true;
    try {
      while (this.#buffer.length > 0 || (final && this.#current)) {
        const formatted = mdToMrkdwn(this.#buffer);

        // Open a new message if we don't have one.
        if (!this.#current) {
          const initial = formatted.length === 0 ? "_…thinking_" : truncate(formatted, Streamer.SEAL_AT);
          const text = final ? initial : initial + Streamer.CURSOR;
          const r = await this.#client.chat.postMessage({
            channel: this.#channel,
            thread_ts: this.#threadTs,
            text,
            mrkdwn: true,
          });
          this.#current = { ts: r.ts as string, text: initial };
          // If we used the whole buffer, drop it; if not, keep overflow.
          if (formatted.length <= Streamer.SEAL_AT) {
            this.#buffer = "";
          } else {
            this.#buffer = formatted.slice(Streamer.SEAL_AT);
          }
          if (final && this.#buffer.length === 0) break;
          continue;
        }

        // Grow the current message.
        const merged = this.#current.text + formatted;
        if (merged.length <= Streamer.SEAL_AT) {
          const text = final ? merged : merged + Streamer.CURSOR;
          await this.#client.chat.update({
            channel: this.#channel,
            ts: this.#current.ts,
            text,
          });
          this.#current.text = merged;
          this.#buffer = "";
          if (final) break;
          break;
        }

        // Seal current at SEAL_AT and roll over.
        const room = Streamer.SEAL_AT - this.#current.text.length;
        const seal = this.#current.text + formatted.slice(0, Math.max(0, room));
        await this.#client.chat.update({
          channel: this.#channel,
          ts: this.#current.ts,
          text: seal,
        });
        this.#buffer = formatted.slice(Math.max(0, room));
        this.#current = null;
      }
    } catch (e) {
      console.error("[streamer] sync failed:", e);
    } finally {
      this.#updateInflight = false;
      this.#pendingFlush = false;
    }
  }
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max);
}

// Re-export for tests.
export { SLACK_MAX_TEXT };
