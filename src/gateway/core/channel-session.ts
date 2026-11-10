/**
 * Channel session mode (docs/superpowers/specs/2026-11-10-channel-session.md).
 * The reserved key only finds the session: a root turn keeps its real message
 * ts as its thread, so nothing Slack-facing ever sees this value.
 */
import type { SlashHit } from "../slack/commands";

export const channelSessionKey = (channelId: string): string => `channel:${channelId}`;

export const isRootChannelEvent = (e: { channel_type?: string; thread_ts?: string }): boolean =>
  !e.thread_ts && e.channel_type !== "im";

/** Text refusing a command that makes no sense at a channel session's root, or null. */
export function refusalAtRoot(hit: SlashHit): string | null {
  if (hit.kind === "one-on-one" || hit.kind === "env" || hit.kind === "remote") return "This channel shares one session, so that can't run at root. Start a thread for this.";
  if (hit.kind === "mention-only") return "The root of this channel is already mention-only.";
  if (hit.kind === "ignore" && hit.target === "thread") return "That only applies inside a thread.";
  if (hit.kind === "unignore" && hit.target === "thread") return "That only applies inside a thread.";
  return null;
}
