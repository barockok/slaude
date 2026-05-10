import type { WebClient } from "@slack/web-api";

/**
 * Slack Assistant thread status indicator (the animated "is thinking…" text
 * that shows next to the bot name in a thread). Powered by
 * `assistant.threads.setStatus`. Requires `assistant:write` scope and the app
 * to be configured as an Agent/Assistant in the manifest.
 *
 * Status auto-clears when the bot posts a reply, but we also clear explicitly
 * on turn end / error. Auto-disables on missing_scope so we don't spam logs.
 */
export class Status {
  #client: WebClient;
  #disabled = false;
  /** sessionId → {channel, threadTs} so we know what to clear. */
  #active = new Map<string, { channel: string; threadTs: string }>();

  constructor(client: WebClient) {
    this.#client = client;
  }

  async set(sessionId: string, channel: string, threadTs: string, text: string) {
    if (this.#disabled) return;
    this.#active.set(sessionId, { channel, threadTs });
    try {
      await (this.#client as any).assistant.threads.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status: text,
      });
    } catch (e: any) {
      const code = e?.data?.error ?? e?.message;
      console.error("[status] setStatus failed:", code);
      if (
        code === "missing_scope" ||
        code === "not_allowed_token_type" ||
        code === "not_in_assistant_thread"
      ) {
        this.#disabled = true;
        console.log(
          "[status] auto-disabled — enable Agents/Assistant in app manifest and add assistant:write scope",
        );
      }
    }
  }

  async clear(sessionId: string) {
    if (this.#disabled) return;
    const a = this.#active.get(sessionId);
    if (!a) return;
    this.#active.delete(sessionId);
    try {
      await (this.#client as any).assistant.threads.setStatus({
        channel_id: a.channel,
        thread_ts: a.threadTs,
        status: "",
      });
    } catch {
      // best-effort
    }
  }
}
