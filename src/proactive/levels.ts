/**
 * The proactive level order: what the agent may do about something it noticed.
 * `ignore < inform < ask < act`. The SOUL states a ceiling (`Highest`); learned
 * reactions can only lower the level, never raise it past that ceiling.
 */
export type Level = "ignore" | "inform" | "ask" | "act";

export const LEVELS: readonly Level[] = ["ignore", "inform", "ask", "act"];

export function levelRank(l: Level): number {
  return LEVELS.indexOf(l);
}

/** The lower of two levels. */
export function minLevel(a: Level, b: Level): Level {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/** A level name (case and surrounding space ignored), or null. */
export function parseLevel(s: string): Level | null {
  const v = s.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : null;
}
