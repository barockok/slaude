/**
 * Every tag the runtime or the gateway wraps text in, or gives meaning to inside a prompt. One list, shared
 * by the two neutralisers: `neutraliseEnvelopeTags` (a message's text, src/gateway/core/channel-session.ts)
 * and the memory block's escape (src/memory/turn-context.ts). Text from a person or a page must never open
 * or close one of these. The thread head escapes every `<` and so does not depend on this list.
 */
export const ENVELOPE_TAG_NAMES = [
  "channel",
  "runtime-check",
  "runtime-baseline",
  "attachment",
  "memory-context",
  "proactive-context",
  "proactive-work",
  "thread-head",
  "skill-args",
  "skill",
  "checklist",
  "channel-mandate",
  "channel-notes",
  "recent-turns",
  "open-commitments",
  "profile",
  "lessons",
  "system-reminder",
  "session-mode",
  "remote-mode",
  "mcp-servers",
  "heartbeat",
  "auto-evolve",
  "cron",
  "wake",
  "user",
  "assistant",
] as const;

/** The names as a regex alternation. */
export const ENVELOPE_TAG_ALTERNATION = ENVELOPE_TAG_NAMES.join("|");
