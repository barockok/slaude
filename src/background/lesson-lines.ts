/**
 * The check code applies to every line the lessons upkeep writes into `self/lessons` (memory places, rc.47).
 * The pass turns lesson proposals from many places into general lines; the prompt asks for lines that name no
 * person, place, channel, customer or task, but only code can promise it. A line is refused when it holds
 * anything that points at a thing: a platform id, a mention, an email address, a URL or host, an internal
 * source id or slug, a typed reference, a message timestamp, a long hex or numeric identifier. Names written in
 * plain words cannot be told from other words by code; the prompt and the proposals' own wording carry that part.
 */

/** One line of a lessons page: `- YYYY-MM-DD <lesson>`. */
const LINE_SHAPE = /^- \d{4}-\d{2}-\d{2} \S/;

const CHECKS: Array<[string, RegExp]> = [
  ["a mention", /<[@#!][^>]*>|(^|[\s(])@[A-Za-z0-9_.-]{2,}/],
  ["a channel name", /(^|[\s(])#[A-Za-z0-9_-]{2,}/],
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/],
  ["a URL", /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\bmailto:/i],
  ["a host name", /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|app|ai|co|sh|cloud|edu|gov|me|xyz|local|internal|slack)\b/i],
  ["an IP address", /\b\d{1,3}(\.\d{1,3}){3}\b/],
  ["a platform id", /\b[A-Z](?=[0-9A-Z]*\d)[0-9A-Z]{6,}\b/],
  ["a typed reference", /\b[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[^\s,;)]+/i],
  ["a source id", /\b(mb|user|agent|profile|kb)-[a-z0-9]{3,}/i],
  ["a page slug", /\b(conversations|people|self|shared|commitments|investigations)\/[^\s,;)]+/i],
  ["a message timestamp", /\b\d{9,10}\.\d{3,6}\b/],
  ["a long identifier", /\b[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{9,}\b/i],
  ["a provenance note", /\(source:|\bsource:\s|\bevidence:/i],
];

/** Why a lessons line may not be written, or null. Names no matched text, so a refusal never repeats an id. */
export function lessonLineViolation(line: string): string | null {
  if (/[\r\n]/.test(line)) return "a lesson is one line";
  if (!LINE_SHAPE.test(line)) return "a lesson line is `- YYYY-MM-DD <the lesson>`";
  for (const [what, re] of CHECKS) if (re.test(line)) return `it holds ${what}`;
  return null;
}

/** The first refusal over a page's lines, as `line <n>: <why>`, or null when every line passes. `keep` lines pass unchecked (already persona-wide). */
export function lessonPageViolation(lines: readonly string[], keep: ReadonlySet<string> = new Set()): string | null {
  for (const [i, l] of lines.entries()) {
    if (keep.has(l)) continue;
    const why = lessonLineViolation(l);
    if (why) return `line ${i + 1}: ${why}`;
  }
  return null;
}
