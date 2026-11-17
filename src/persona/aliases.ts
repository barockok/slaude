/**
 * Persona aliases: extra names the agent answers to when a channel lets it
 * join in without an @mention. Checked once, here, so the schema, the compile
 * step and any later reader agree.
 */

export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 32;
export const ALIAS_MAX_COUNT = 8;

/** One token: letters or digits first, then letters, digits, `_`, `-` or `.`. */
export const ALIAS_SHAPE_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

/**
 * Words that would match ordinary sentences. Small on purpose: a deployment
 * that needs a stricter list can pick a longer or less common alias. Matching
 * is case-folded, so one spelling covers all.
 */
export const COMMON_WORD_DENYLIST: ReadonlySet<string> = new Set([
  "the", "and", "for", "you", "your", "any", "can", "but", "not", "are", "was", "has", "had", "have",
  "this", "that", "with", "from", "they", "them", "will", "would", "could", "should", "what", "when", "where",
  "who", "why", "how", "yes", "yeah", "hey", "hello", "hi", "thanks", "thank", "please", "sorry", "okay",
  "bot", "team", "everyone", "everybody", "here", "channel", "help", "someone", "anyone", "guys", "folks",
  "agent", "assistant", "ai", "slack", "chat", "user", "admin", "all", "now", "today", "good", "just",
]);

/** Fold for comparison: trimmed, locale-independent lower case. */
export const foldAlias = (a: string): string => a.trim().toLowerCase();

export interface AliasIssue {
  /** Index in the list, or null for a problem with the list itself. */
  index: number | null;
  message: string;
}

/** Problems with an aliases list. Messages never carry the offending value. */
export function aliasIssues(list: readonly string[]): AliasIssue[] {
  const out: AliasIssue[] = [];
  if (list.length > ALIAS_MAX_COUNT) out.push({ index: null, message: `has more than ${ALIAS_MAX_COUNT} aliases` });
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const a = raw.trim();
    if (a.length < ALIAS_MIN_LENGTH) out.push({ index, message: `must be at least ${ALIAS_MIN_LENGTH} characters` });
    else if (a.length > ALIAS_MAX_LENGTH) out.push({ index, message: `is longer than ${ALIAS_MAX_LENGTH} characters` });
    else if (!ALIAS_SHAPE_RE.test(a)) out.push({ index, message: "must be one word of letters, digits, _, - or ." });
    else if (COMMON_WORD_DENYLIST.has(foldAlias(a))) out.push({ index, message: "is a common word that would match ordinary messages; pick a more distinctive name" });
    const f = foldAlias(a);
    if (seen.has(f)) out.push({ index, message: "repeats an earlier alias (names are compared without regard to case)" });
    seen.add(f);
  });
  return out;
}
