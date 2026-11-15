/**
 * Token shapes: the values a configuration file must never carry. One list for
 * `personas export` (a url path, a command string, an arg) and for environment
 * definitions (any value). Slack, GitHub, OpenAI-style, AWS access keys, a
 * Bearer prefix, a JWT, a PEM block, and any run of 32+ token characters (most
 * hosted secrets). False positives fail safe: the operator edits the file first.
 */
export const TOKEN_SHAPES: RegExp[] = [
  /xox[a-z]-/i,
  /\bgh[opusr]_[A-Za-z0-9]/,
  /github_pat_/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /\bbearer\b/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  /-----BEGIN [A-Z ]*-----/,
  /[A-Za-z0-9_-]{32,}/,
];
export const looksLikeToken = (s: string): boolean => TOKEN_SHAPES.some((re) => re.test(s));

/**
 * The narrower rule for values that are not credentials by default (an
 * environment definition's host, directory and description). It keeps every real
 * token shape and drops the two that reject honest text: the word "bearer" on its
 * own, and any 32 character run (a long hyphenated host label, a UUID path
 * segment). A bare long run counts only when it is one unbroken word of letters,
 * digits and underscores that mixes letters and digits, the shape of a hosted API
 * secret.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /xox[a-z]-/i,
  /\bgh[opusr]_[A-Za-z0-9]/,
  /github_pat_/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  /-----BEGIN [A-Z ]*-----/,
];
const LONG_WORD = /[A-Za-z0-9_]{32,}/g;
export function looksLikeCredential(s: string): boolean {
  if (CREDENTIAL_SHAPES.some((re) => re.test(s))) return true;
  for (const m of s.match(LONG_WORD) ?? []) {
    if (/[A-Za-z]/.test(m) && /[0-9]/.test(m)) return true;
  }
  return false;
}
