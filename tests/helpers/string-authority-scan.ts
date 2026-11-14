/**
 * The scanner behind tests/access/no-string-authority.test.ts: finds places in
 * `src` that decide by comparing Slack user id strings (a speaker against a
 * manager, a lock owner, an approver list, a soul field) instead of going
 * through the access seam. A hit is exempt when its line names a registered
 * site id (`site: "<id>"`, or `managerAt("<id>"`); anything else needs a
 * reviewed line in tests/access/string-authority.allow.json.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../../src/access/sites";

/** The plan's patterns first, then two broad ones that catch a compare the plan's list does not name. */
const ID_WORD = String.raw`(?:[\w.?]*(?:[uU]serId|[mM]anager\w*|[iI]nitiator|runAs\w*|lockedUser|locked_user|toUser|clicker|slackUserId)\b|\bby)`;
export const PATTERNS: Record<string, RegExp> = {
  "user-id-dot-eq": /\.userId ===/,
  "eq-user-id": /=== userId/,
  "neq-user-id": /userId !== /,
  locked_user: /(?<![A-Za-z])locked_user/,
  "locked-user-cmp": /lockedUser (!|=)==/,
  "managers-includes": /managers\.includes/,
  "manager-user-id": /\.manager\??\.userId/,
  "backup-manager-user-id": /backupManager\??\.userId/,
  "approvers-has": /approvers\.(has|includes)/,
  "dm-allowed": /dmAllowedUsers/,
  blocked: /blockedUsers/,
  // Any id-looking operand on either side of a strict (in)equality, unless the other side is a literal.
  "id-compare": new RegExp(`(?:${ID_WORD}\\s*[!=]==\\s*(?!null\\b|undefined\\b|"|'|\`|true\\b|false\\b|0\\b)|[!=]==\\s*${ID_WORD})`),
  // Membership of an id in a list or set that names people.
  "id-membership": new RegExp(
    String.raw`(?:(?:[Mm]anagers?|[Aa]pprovers?|[Uu]sers?|[Mm]embers|[Aa]dmins)\.(?:includes|has)\(|\.(?:includes|has)\((?:[\w.?]*(?:[uU]serId|[mM]anager\w*|clicker|by|who|uid|speaker|sender)\b)\))`,
  ),
};

export interface Hit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

const SITE_IDS = SITES.map((s) => s.id);
const tagOf = (line: string): { id: string; at: number } | null => {
  for (const id of SITE_IDS) {
    for (const needle of [`site: "${id}"`, `managerAt("${id}"`]) {
      const at = line.indexOf(needle);
      if (at >= 0) return { id, at };
    }
  }
  return null;
};

/**
 * The line with its registered seam call cut out, or null when it names no
 * registered site. The call is the nearest enclosing `name(` around the site
 * tag, to its matching `)`. What is left is whatever else the line compares.
 */
export function withoutSeamCall(line: string): string | null {
  const tag = tagOf(line);
  if (!tag) return null;
  let depth = 0;
  let start = -1;
  for (let i = tag.at; i >= 0; i--) {
    const ch = line[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  const name = /[A-Za-z_$][\w$]*$/.exec(line.slice(0, start));
  const from = name ? start - name[0].length : start;
  depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return line.slice(0, from) + " " + line.slice(i + 1);
  }
  return null;
}

/** A line that names a registered site id at a seam call. */
export const isRegistered = (line: string): boolean => withoutSeamCall(line) !== null;

/** Whitespace-collapsed text, the identity of an allowlisted line. */
export const normalise = (line: string): string => line.trim().replace(/\s+/g, " ");

const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);

/** Hits in one file's text that no registered site covers. A site call exempts only what is inside it. */
export function scanText(file: string, text: string): Hit[] {
  const out: Hit[] = [];
  text.split("\n").forEach((l, i) => {
    if (isComment(l)) return;
    const rest = withoutSeamCall(l) ?? l;
    // The broad patterns ignore a compare with null, undefined or a string literal (a presence or type check).
    const plain = rest.replace(/(?:[!=]==\s*(?:null|undefined)\b|\b(?:null|undefined)\s*[!=]==|[!=]==\s*"[^"]*"|[!=]==\s*'[^']*')/g, " ");
    for (const [pattern, re] of Object.entries(PATTERNS)) {
      const broad = pattern === "id-compare" || pattern === "id-membership";
      if ((broad ? plain : rest).match(re)) out.push({ file, line: i + 1, pattern, text: normalise(l) });
    }
  });
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
}

/** Every source file under `root` (default: all of src). */
export function sourceFiles(root = "src"): string[] {
  const files: string[] = [];
  walk(root, files);
  return files.sort();
}

/** Every file under `root` (default: all of src), scanned. */
export function scanTree(root = "src"): Hit[] {
  return sourceFiles(root).flatMap((f) => scanText(f, readFileSync(f, "utf8")));
}

export interface AllowEntry {
  file: string;
  pattern: string;
  /** The reviewed lines (whitespace-normalised, one per hit). A changed or swapped line is a new hit. */
  lines: string[];
  reason: string;
}

/** The problems with `hits` against `allow`; empty when every hit is a reviewed line. */
export function checkAgainstAllowlist(hits: readonly Hit[], allow: readonly AllowEntry[]): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, Hit[]>();
  for (const h of hits) byKey.set(`${h.file}|${h.pattern}`, [...(byKey.get(`${h.file}|${h.pattern}`) ?? []), h]);
  const entries = new Map(allow.map((e) => [`${e.file}|${e.pattern}`, e]));
  for (const [key, hs] of byKey) {
    const e = entries.get(key);
    const left = [...(e?.lines ?? [])];
    for (const h of hs) {
      const i = left.indexOf(h.text);
      if (i >= 0) left.splice(i, 1);
      else problems.push(`unregistered string authority compare: ${h.file}:${h.line} [${h.pattern}] ${h.text}`);
    }
  }
  for (const e of allow) {
    if (!e.reason.trim()) problems.push(`allowlist entry without a reason: ${e.file} [${e.pattern}]`);
    const left = [...(byKey.get(`${e.file}|${e.pattern}`) ?? []).map((h) => h.text)];
    for (const l of e.lines) {
      const i = left.indexOf(l);
      if (i >= 0) left.splice(i, 1);
      else problems.push(`stale allowlist line: ${e.file} [${e.pattern}] ${l}`);
    }
  }
  return problems;
}
