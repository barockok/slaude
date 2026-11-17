/**
 * Persona aliases: extra names the agent answers to when a channel lets it
 * join in without an @mention. Checked once, here, so the schema, the compile
 * step, the stored structure and the registry agree.
 *
 * Names are compared as NFKC-normalised, lower-cased text, so a full-width or
 * differently-cased spelling is the same name. An alias is letters and digits
 * only, all of one script where scripts can be confused.
 */

export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 32;
export const ALIAS_MAX_COUNT = 8;

/** Normalise for storage and comparison steps: trimmed, NFKC. Case is kept. */
export const normalizeAlias = (a: string): string => a.trim().normalize("NFKC");
/** Fold for comparison: NFKC then lower case. */
export const foldAlias = (a: string): string => normalizeAlias(a).toLowerCase();

/** Length in code points, not UTF-16 units. */
const length = (s: string): number => [...s].length;

/** After folding: letters and digits only (no punctuation, spaces, marks or symbols). */
const SHAPE_RE = /^[\p{L}\p{N}]+$/u;

/** Scripts that share look-alike letters; one alias may use only one of them. */
const CONFUSABLE = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u];
const mixesScripts = (s: string): boolean => CONFUSABLE.filter((re) => re.test(s)).length > 1;

/**
 * Words that would match ordinary sentences. Small on purpose: a deployment
 * that needs a stricter list can pick a longer or less common alias. Entries
 * are folded; ones below the minimum length are refused by the length rule.
 */
export const COMMON_WORD_DENYLIST: ReadonlySet<string> = new Set(
  [
    "the", "and", "for", "you", "your", "any", "can", "but", "not", "are", "was", "has", "had", "have",
    "this", "that", "with", "from", "they", "them", "will", "would", "could", "should", "what", "when", "where",
    "who", "why", "yes", "yeah", "hey", "hello", "thanks", "thank", "please", "sorry", "okay",
    "bot", "team", "everyone", "everybody", "here", "channel", "help", "someone", "anyone", "guys", "folks",
    "agent", "assistant", "slack", "chat", "user", "admin", "now", "today", "good", "just",
  ].filter((w) => w.length >= ALIAS_MIN_LENGTH),
);

export interface AliasIssue {
  /** Index in the list, or null for a problem with the list itself. */
  index: number | null;
  message: string;
}

/**
 * Problems with an aliases list. Messages never carry the offending value.
 * `ownName`: the persona's own name, which an alias may not repeat.
 */
export function aliasIssues(list: readonly string[], ownName?: string): AliasIssue[] {
  const out: AliasIssue[] = [];
  if (list.length > ALIAS_MAX_COUNT) out.push({ index: null, message: `has more than ${ALIAS_MAX_COUNT} aliases` });
  const own = ownName === undefined ? null : foldAlias(ownName);
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const a = normalizeAlias(raw);
    const f = a.toLowerCase();
    const n = length(a);
    if (n < ALIAS_MIN_LENGTH) out.push({ index, message: `must be at least ${ALIAS_MIN_LENGTH} characters` });
    else if (n > ALIAS_MAX_LENGTH) out.push({ index, message: `is longer than ${ALIAS_MAX_LENGTH} characters` });
    else if (!SHAPE_RE.test(f)) out.push({ index, message: "must be one word of letters and digits only" });
    else if (mixesScripts(a)) out.push({ index, message: "mixes look-alike scripts (for example Latin and Cyrillic letters)" });
    else if (COMMON_WORD_DENYLIST.has(f)) out.push({ index, message: "is a common word that would match ordinary messages; pick a more distinctive name" });
    else if (own !== null && f === own) out.push({ index, message: "is the agent's own name, which always counts; remove it" });
    if (seen.has(f)) out.push({ index, message: "repeats an earlier alias (names are compared without regard to case or width)" });
    seen.add(f);
  });
  return out;
}

/**
 * Names claimed by more than one persona, or an alias equal to another
 * persona's name. Returns one line per problem naming persona and index, never
 * the value.
 */
export function aliasConflicts(personas: ReadonlyArray<{ name: string; aliases: readonly string[] }>): string[] {
  const out: string[] = [];
  const names = new Map(personas.map((p) => [foldAlias(p.name), p.name]));
  const claimed = new Map<string, string>();
  for (const p of personas) {
    p.aliases.forEach((raw, i) => {
      const f = foldAlias(raw);
      const other = names.get(f);
      if (other !== undefined && other !== p.name) out.push(`persona '${p.name}': aliases[${i}] is the name of persona '${other}'`);
      const first = claimed.get(f);
      if (first !== undefined && first !== p.name) out.push(`persona '${p.name}': aliases[${i}] is also claimed by persona '${first}'`);
      else claimed.set(f, p.name);
    });
  }
  return out;
}
