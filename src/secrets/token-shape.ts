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
