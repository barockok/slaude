/**
 * The scanner behind tests/slices/no-string-slice.test.ts (slice F): finds every
 * place in `src` that turns a Slack user id into a `user-` slice name, reads a
 * slice name back as a person, or resolves a Slack id to a credential account.
 * Each such line must be a reviewed entry in tests/slices/string-slice.allow.json
 * with a reason (the site is deliberately left on the old reading, or is the
 * resolver/scope code itself), so a new site cannot appear by accident.
 */
import { sourceFiles, normalise } from "./string-authority-scan";

export const SLICE_PATTERNS: Record<string, RegExp> = {
  "user-source-id": /\buserSourceId\(/,
  "user-prefix": /startsWith\("user-"\)|slice\("user-"\.length\)/,
  "account-for-slack": /\baccountForSlackUser\b/,
  "account-any-team": /\baccountIdsForSlackUserAnyTeam\b/,
  "epoch-owners": /\bepochOwnersFor\b/,
};

export interface SliceHit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

export interface SliceAllow {
  file: string;
  pattern: string;
  lines: string[];
  reason: string;
}

const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);
const isImport = (l: string): boolean => /^\s*import\b/.test(l) || /^\s*}\s*from\s/.test(l);

export function scanSliceText(file: string, text: string): SliceHit[] {
  const out: SliceHit[] = [];
  text.split("\n").forEach((l, i) => {
    if (isComment(l) || isImport(l)) return;
    for (const [pattern, re] of Object.entries(SLICE_PATTERNS)) if (re.test(l)) out.push({ file, line: i + 1, pattern, text: normalise(l) });
  });
  return out;
}

export function scanSliceTree(root = "src", read: (f: string) => string): SliceHit[] {
  return sourceFiles(root).flatMap((f) => scanSliceText(f, read(f)));
}

/** Hits not covered by an allowlist entry, plus allowlist lines that match nothing (stale). */
export function checkSliceAllowlist(hits: SliceHit[], allow: SliceAllow[]): string[] {
  const problems: string[] = [];
  const allowed = new Map<string, boolean>();
  for (const e of allow) for (const l of e.lines) allowed.set(`${e.file}|${e.pattern}|${normalise(l)}`, false);
  for (const h of hits) {
    const k = `${h.file}|${h.pattern}|${h.text}`;
    if (allowed.has(k)) allowed.set(k, true);
    else problems.push(`unregistered ${h.pattern} at ${h.file}:${h.line}: ${h.text}`);
  }
  for (const [k, used] of allowed) if (!used) problems.push(`stale allowlist line: ${k}`);
  return problems;
}
