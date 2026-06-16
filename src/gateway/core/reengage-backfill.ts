/**
 * Pure helpers for the re-engage backfill — selecting and rendering the thread
 * messages that were dropped at the gate while a thread was disengaged, so the
 * agent can catch up when it is re-@mentioned.
 *
 * Kept deterministic and side-effect-free (no Slack I/O) so the selection and
 * formatting are unit-testable; the gateway does the actual fetch + name
 * resolution and hands the results here.
 */

export interface GapMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  username?: string;
}

export interface SelectOpts {
  /** The agent's own user id — its messages are excluded. */
  botId?: string | null;
  /** The agent's own bot id — its bot posts are excluded. */
  selfBotId?: string | null;
  /** ts of the re-engaging @mention — excluded (it's the current message). */
  reengageTs: string;
  /** ts of the thread root — excluded. */
  threadTs: string;
  /** Keep at most this many, most-recent-first priority. */
  maxMsgs: number;
}

export interface GapSelection {
  /** The retained messages, in chronological order. */
  kept: GapMessage[];
  /** How many real gap messages were dropped by the cap. */
  omitted: number;
  /** Total real gap messages before the cap. */
  total: number;
}

/**
 * Filter a thread slice down to the real user messages posted in the gap, then
 * keep the most recent `maxMsgs` (chronological order preserved).
 */
export function selectGapMessages(messages: GapMessage[], o: SelectOpts): GapSelection {
  const gap = (messages ?? []).filter((m) => {
    if (!m || m.ts === o.reengageTs || m.ts === o.threadTs) return false; // root + trigger
    if (m.subtype) return false; // joins / edits / system
    if (m.bot_id && o.selfBotId && m.bot_id === o.selfBotId) return false; // our own posts
    if (m.user && o.botId && m.user === o.botId) return false;
    return typeof m.text === "string" && m.text.trim().length > 0;
  });
  const omitted = Math.max(0, gap.length - o.maxMsgs);
  const kept = gap.slice(-o.maxMsgs); // recency-prioritized selection, chronological
  return { kept, omitted, total: gap.length };
}

/**
 * Render the selection as a context preamble. `nameOf` resolves a display name
 * for a message (the gateway pre-resolves Slack user names). Returns undefined
 * when there is nothing to show.
 */
export function renderBackfillPreamble(
  sel: GapSelection,
  nameOf: (m: GapMessage) => string,
  lineMax = 300,
): string | undefined {
  if (sel.kept.length === 0) return undefined;
  const lines = sel.kept.map(
    (m) => `  ${nameOf(m)}: ${(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, lineMax)}`,
  );
  const header =
    sel.omitted > 0
      ? `[While you were disengaged from this thread, ${sel.total} messages were posted — showing the latest ${sel.kept.length}, ${sel.omitted} earlier omitted:]`
      : `[While you were disengaged from this thread, these messages were posted (you did not see them):]`;
  return `${header}\n${lines.join("\n")}\n[You are now re-engaged. Catch up on the above, then respond to the latest message.]`;
}
