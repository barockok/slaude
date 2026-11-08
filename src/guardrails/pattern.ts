/**
 * Patterns for owner guardrails. Every regex runs on re2js, a linear-time
 * engine: no pattern can backtrack catastrophically, and the constructs that
 * would need backtracking (backreferences, lookaround) fail to compile. Every
 * pattern runs in dotall mode (`.` crosses newlines), is length capped, and is
 * compiled once when its guardrail is parsed. Strings are matched whole up to
 * a large cap (RE2 is linear, so the cost is bounded by the input); a string
 * over the cap is too large to check, and match.ts treats that as a match for
 * deny and approve rules (fail closed).
 *
 * Tool names are matched with a glob (`*` any run of characters, `?` one),
 * compiled to an anchored RE2 pattern.
 */
import { RE2JS } from "re2js";

/** Longest pattern source a rule may carry. */
export const MAX_PATTERN_CHARS = 512;
/** Most characters of one string a pattern checks; a longer one is too large to check. */
export const MAX_MATCH_CHARS = 1024 * 1024;

export interface Pattern {
  source: string;
  test(text: string): boolean;
  /** Every match replaced with `with` (text patterns; a glob has none). */
  replace?(text: string, with_: string): string;
  /** The matched spans, in order (text patterns). */
  matches?(text: string): string[];
}

/** The redaction marker, the same as the soul's redact patterns use. */
export const REDACTED = "[REDACTED]";

export class PatternError extends Error {}

/** Compile `source` (dotall), or throw a PatternError naming the problem. */
export function compilePattern(source: unknown, what: string): Pattern {
  if (typeof source !== "string" || source.length === 0) throw new PatternError(`${what} must be a non-empty pattern`);
  if (source.length > MAX_PATTERN_CHARS) throw new PatternError(`${what} is ${source.length} characters; at most ${MAX_PATTERN_CHARS}`);
  let re: RE2JS;
  try {
    re = RE2JS.compile(source, RE2JS.DOTALL);
  } catch (e) {
    throw new PatternError(`${what} is not a valid pattern (${(e as Error).message})`);
  }
  // `$` in the replacement is literal: quote it for RE2's group syntax.
  const matches = (text: string): string[] => {
    const m = re.matcher(capText(text));
    const out: string[] = [];
    while (m.find() && out.length < 1000) out.push(m.group() ?? "");
    return out;
  };
  return { source, test: (text) => re.test(capText(text)), replace: (text, with_) => re.matcher(text).replaceAll(with_.replace(/\$/g, "$$$$")), matches };
}

/** `text` cut to the match budget (a best-effort prefix for audit rules). */
export function capText(text: string): string {
  return text.length > MAX_MATCH_CHARS ? text.slice(0, MAX_MATCH_CHARS) : text;
}

/** Longest tool-name glob. */
export const MAX_GLOB_CHARS = 256;

/** A glob over a full tool name, as an anchored pattern. */
export function compileGlob(glob: unknown, what: string): Pattern {
  if (typeof glob !== "string" || glob.length === 0) throw new PatternError(`${what} must be a non-empty tool name or glob`);
  if (glob.length > MAX_GLOB_CHARS) throw new PatternError(`${what} is ${glob.length} characters; at most ${MAX_GLOB_CHARS}`);
  let src = "";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += RE2JS.quote(ch);
  }
  const re = RE2JS.compile(src, RE2JS.DOTALL);
  return { source: glob, test: (name) => re.testExact(name) };
}
