/**
 * Channel session mode (docs/superpowers/specs/2026-11-10-channel-session.md).
 * The reserved key only finds the session: a root turn keeps its real message
 * ts as its thread, so nothing Slack-facing ever sees this value.
 */
import type { SlashHit } from "../slack/commands";

export const channelSessionKey = (channelId: string): string => `channel:${channelId}`;

/** Whether a session row's `slack_thread_ts` is a channel session's key. */
export const isChannelSessionKey = (threadTs: unknown): boolean => typeof threadTs === "string" && threadTs.startsWith("channel:");

export const isRootChannelEvent = (e: { channel_type?: string; thread_ts?: string }): boolean =>
  !e.thread_ts && e.channel_type !== "im";

/** The tags the gateway and the runtime wrap a turn's text in. */
const ENVELOPE_TAGS = "channel|runtime-check|attachment|memory-context|proactive-context|proactive-work";
const FORGED_TAG = new RegExp(`(<|&lt;)(/?)\\s*(${ENVELOPE_TAGS})\\b`, "gi");

/**
 * A message's own text can never open or close one of those tags. A channel
 * session records what every member posts, so this is what stops a post forging
 * another person's envelope, and with it an approval. Slack's own markup
 * (`<@U1>`, `<!channel>`, `<#C1|name>`) does not match.
 */
export const neutraliseEnvelopeTags = (text: string): string => text.replace(FORGED_TAG, (_, _open: string, slash: string, tag: string) => `[${slash}${tag}`);

/** Text refusing a command that makes no sense at a channel session's root, or null. */
export function refusalAtRoot(hit: SlashHit): string | null {
  if (hit.kind === "one-on-one" || hit.kind === "env" || hit.kind === "remote") return "This channel shares one session, so that can't run at root. Start a thread for this.";
  if (hit.kind === "mention-only") return "The root of this channel is already mention-only.";
  if (hit.kind === "ignore" && hit.target === "thread") return "That only applies inside a thread.";
  if (hit.kind === "unignore" && hit.target === "thread") return "That only applies inside a thread.";
  return null;
}
