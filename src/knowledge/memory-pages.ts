/**
 * Typed memory pages (spec §8.2, §8.3): compose and read the common
 * frontmatter `kb_memoize` writes, and read page records back. Pure, no I/O.
 *
 * A typed page is `---`, then `type`, `as_of` and `confidence`, then
 * `source`, `subject`, `supersedes` and the type's own fields, then `---` and
 * the body. `subject` is the Slack user id the page is about (memory_about
 * finds a person's pages by it).
 * Values are one line each. Free text (source, supersedes, every field) is
 * always a JSON string, which is a valid YAML double-quoted scalar, so any
 * YAML parser (gbrain's included) reads back exactly the string written; a
 * plain `@alice`, `>later`, `- x` or `2026-11-01` would not. Only values
 * composePage itself validated (type, as_of, confidence, a commitment's
 * status and on_no_change) are written plain.
 *
 * A superseded page is not rewritten: the new page names it in `supersedes`
 * and the old one gets the gbrain tag SUPERSEDED_TAG (memory-trail.ts).
 */
import { redactSecrets } from "../gateway/core/status-text";

import { SUPERSEDED_TAG } from "./memory-trail";
import { PAGE_TYPES, type PageType } from "./page-types";

export { PAGE_TYPES, type PageType };

export type Confidence = "told" | "inferred";

/** One kb_memoize page as the model sends it. */
export interface TypedPageInput {
  slug: string;
  /** The page body for a typed page; the whole page (frontmatter and all) for an untyped one. */
  content: string;
  summary?: string;
  type?: string;
  confidence?: string;
  source?: string;
  /** Slack user id the page is about. */
  subject?: string;
  supersedes?: string;
  fields?: Record<string, string>;
}

/** Keys composePage writes itself; a type's fields may not reuse them. */
const COMMON_KEYS = new Set(["type", "as_of", "confidence", "source", "subject", "supersedes", "superseded_by"]);

/** Commitment keys, in the order they are written (global constraints). */
const COMMITMENT_KEYS = ["promiser", "beneficiary", "thread", "due", "check", "on_no_change", "status"] as const;
const COMMITMENT_STATUS = new Set(["open", "done", "dropped"]);
const ON_NO_CHANGE = new Set(["close-in-one-line", "silent"]);

export const CREDENTIAL_REFUSAL = "refused: page contains a credential-like value; remove that value and try again";

const FIELD_KEY = /^[a-z][a-z0-9_]*$/;

/** A field value as one YAML line: plain only for a validated enum value. */
function fieldValue(k: string, v: string): string {
  if ((k === "status" && COMMITMENT_STATUS.has(v)) || (k === "on_no_change" && ON_NO_CHANGE.has(v))) return v;
  return JSON.stringify(v);
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Build the page's markdown, or say why it is refused. A page without `type`
 * is passed through as written (old untyped calls keep working), except that
 * no page may carry a credential-like value.
 */
export function composePage(p: TypedPageInput, now: Date): { content: string } | { error: string } {
  if (p.type === undefined) {
    if (p.confidence !== undefined || p.source !== undefined || p.subject !== undefined || p.supersedes !== undefined || p.fields !== undefined) {
      return { error: `refused: confidence, source, subject, supersedes and fields need a type (one of ${PAGE_TYPES.join(", ")})` };
    }
    return redactSecrets(p.content) === p.content ? { content: p.content } : { error: CREDENTIAL_REFUSAL };
  }
  const type = p.type as PageType;
  if (!PAGE_TYPES.includes(type)) return { error: `refused: unknown page type "${p.type}"; use one of ${PAGE_TYPES.join(", ")}` };
  if (/^---\r?\n/.test(p.content)) {
    return { error: "refused: a typed page's content is the body only; pass type, source and fields as arguments, not as frontmatter" };
  }

  let confidence = p.confidence;
  if (confidence !== undefined && confidence !== "told" && confidence !== "inferred") {
    return { error: `refused: confidence must be "told" or "inferred"` };
  }
  if (type === "profile") {
    if (confidence === "inferred") return { error: `refused: a profile holds only what the person said: confidence must be "told"` };
    confidence = "told";
  }
  if (type === "person-note") {
    if (confidence === "told") return { error: `refused: a person-note is an observation: confidence must be "inferred"` };
    confidence = "inferred";
  }
  if (p.supersedes !== undefined && p.supersedes === p.slug) return { error: "refused: a page cannot supersede itself" };

  const fields = p.fields ?? {};
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELD_KEY.test(k)) return { error: `refused: field name "${k}" must be lower-case letters, digits and _` };
    if (COMMON_KEYS.has(k)) return { error: `refused: "${k}" is a common key; pass it as its own argument` };
    if (typeof v !== "string" || /[\r\n]/.test(v)) return { error: `refused: field "${k}" must be one line of text` };
  }
  let fieldOrder = Object.keys(fields);
  if (type === "commitment") {
    if (fields.status === undefined) return { error: "refused: a commitment needs fields.status (open, done or dropped)" };
    if (!COMMITMENT_STATUS.has(fields.status)) return { error: `refused: commitment status must be open, done or dropped` };
    if (fields.beneficiary === undefined) return { error: "refused: a commitment needs fields.beneficiary" };
    const known: string[] = COMMITMENT_KEYS.filter((k) => fields[k] !== undefined);
    fieldOrder = [...known, ...fieldOrder.filter((k) => !known.includes(k))];
  }
  if (fields.on_no_change !== undefined && !ON_NO_CHANGE.has(fields.on_no_change)) {
    return { error: "refused: on_no_change must be close-in-one-line or silent" };
  }
  for (const [k, v] of [["source", p.source], ["subject", p.subject], ["supersedes", p.supersedes]] as const) {
    if (v !== undefined && /[\r\n]/.test(v)) return { error: `refused: ${k} must be one line of text` };
  }

  const lines = ["---", `type: ${type}`, `as_of: ${isoDate(now)}`];
  if (confidence !== undefined) lines.push(`confidence: ${confidence}`);
  if (p.source !== undefined) lines.push(`source: ${JSON.stringify(p.source)}`);
  if (p.subject !== undefined) lines.push(`subject: ${JSON.stringify(p.subject)}`);
  if (p.supersedes !== undefined) lines.push(`supersedes: ${JSON.stringify(p.supersedes)}`);
  for (const k of fieldOrder) lines.push(`${k}: ${fieldValue(k, fields[k]!)}`);
  lines.push("---");
  const content = `${lines.join("\n")}\n${p.content}`;
  return redactSecrets(content) === content ? { content } : { error: CREDENTIAL_REFUSAL };
}

/** The frontmatter block: [whole match incl. closing line, inner text]. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const s = JSON.parse(v);
      if (typeof s === "string") return s;
    } catch {
      /* not JSON: keep it as written */
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * A page's top-level `key: value` frontmatter lines, as strings, and the body
 * after the block. Nested YAML (lists, maps) is not interpreted: such a key
 * reads as its raw first-line text. No frontmatter: empty meta, whole body.
 */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) continue;
    meta[kv[1]!] = unquote((kv[2] ?? "").trim());
  }
  return { meta, body: content.slice(m[0].length) };
}

/** A frontmatter value as text; a YAML date (gbrain parses an unquoted as_of) as YYYY-MM-DD. */
function metaText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * A get_page result as frontmatter + body, or null for no page. Takes either
 * the whole page as `content` (the shape kb_memoize writes) or gbrain's page
 * record (`compiled_truth` body, parsed `frontmatter` object); the record's
 * own `tags` mark it superseded too. The one reader of page records: every
 * memory reader (memory_about, the per-turn memory context) goes through it.
 */
export function readPageRecord(raw: unknown): { meta: Record<string, string>; body: string; superseded: boolean } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as { content?: unknown; compiled_truth?: unknown; frontmatter?: unknown; tags?: unknown; type?: unknown };
  const superseded = Array.isArray(r.tags) && r.tags.includes(SUPERSEDED_TAG);
  if (typeof r.content === "string") return { ...parseFrontmatter(r.content), superseded };
  if (typeof r.compiled_truth !== "string") return null;
  const meta: Record<string, string> = {};
  if (r.frontmatter && typeof r.frontmatter === "object") {
    for (const [k, v] of Object.entries(r.frontmatter as Record<string, unknown>)) {
      const t = metaText(v);
      if (t !== undefined) meta[k] = t;
    }
  }
  // Measured against the real engine: gbrain keeps a page's `type` in its own
  // column (not in the record's frontmatter), and returns a YAML date such as
  // `as_of` as an ISO timestamp string.
  if (meta.type === undefined && typeof r.type === "string" && r.type) meta.type = r.type;
  if (meta.as_of !== undefined && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?Z$/.test(meta.as_of)) meta.as_of = meta.as_of.slice(0, 10);
  return { meta, body: r.compiled_truth, superseded };
}
