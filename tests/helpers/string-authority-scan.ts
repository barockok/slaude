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
/** A line that names a registered site id at a seam call. */
export const isRegistered = (line: string): boolean => SITE_IDS.some((id) => line.includes(`site: "${id}"`) || line.includes(`managerAt("${id}"`));

const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);

/** Hits in one file's text that no registered site covers. */
export function scanText(file: string, text: string): Hit[] {
  const out: Hit[] = [];
  text.split("\n").forEach((l, i) => {
    if (isComment(l) || isRegistered(l)) return;
    // The broad patterns ignore a compare with null, undefined or a string literal (a presence or type check).
    const plain = l.replace(/(?:[!=]==\s*(?:null|undefined)\b|\b(?:null|undefined)\s*[!=]==|[!=]==\s*"[^"]*"|[!=]==\s*'[^']*')/g, " ");
    for (const [pattern, re] of Object.entries(PATTERNS)) {
      const broad = pattern === "id-compare" || pattern === "id-membership";
      if ((broad ? plain : l).match(re)) out.push({ file, line: i + 1, pattern, text: l.trim() });
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
  /** How many hits of this pattern the file has. A new compare raises the count and fails the test. */
  count: number;
  reason: string;
}

/** The problems with `hits` against `allow`; empty when every hit is reviewed. */
export function checkAgainstAllowlist(hits: readonly Hit[], allow: readonly AllowEntry[]): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, Hit[]>();
  for (const h of hits) byKey.set(`${h.file}|${h.pattern}`, [...(byKey.get(`${h.file}|${h.pattern}`) ?? []), h]);
  const entries = new Map(allow.map((e) => [`${e.file}|${e.pattern}`, e]));
  for (const [key, hs] of byKey) {
    const e = entries.get(key);
    if (!e) {
      for (const h of hs) problems.push(`unregistered string authority compare: ${h.file}:${h.line} [${h.pattern}] ${h.text}`);
    } else if (hs.length > e.count) {
      problems.push(`${hs.length - e.count} new hit(s) of [${e.pattern}] in ${e.file} beyond the ${e.count} reviewed: ${hs.map((h) => `:${h.line} ${h.text}`).join(" | ")}`);
    }
  }
  for (const e of allow) {
    const n = byKey.get(`${e.file}|${e.pattern}`)?.length ?? 0;
    if (n < e.count) problems.push(`stale allowlist entry: ${e.file} [${e.pattern}] lists ${e.count} but ${n} remain; lower it or remove it`);
    if (!e.reason.trim()) problems.push(`allowlist entry without a reason: ${e.file} [${e.pattern}]`);
  }
  return problems;
}
