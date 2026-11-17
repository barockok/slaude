/**
 * Slack id shapes, defined once. `agent-schema.ts` re-exports the two regexes;
 * the reference grammar builds its patterns from the same sources. Do not
 * loosen them: a Slack id is upper-case letters and digits as Slack issues it.
 */
export const USER_ID_SRC = "[UW][A-Z0-9]+";
export const CHANNEL_ID_SRC = "[CGD][A-Z0-9]+";
export const USER_ID_RE = new RegExp(`^${USER_ID_SRC}$`);
export const CHANNEL_ID_RE = new RegExp(`^${CHANNEL_ID_SRC}$`);
