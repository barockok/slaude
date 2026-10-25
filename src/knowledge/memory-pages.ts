/**
 * Typed memory pages (spec §8.2, §8.3): compose and read the common
 * frontmatter `kb_memoize` writes. Pure, no I/O.
 *
 * A typed page is `---`, then `type`, `as_of` and `confidence`, then
 * `source`, `supersedes` and the type's own fields, then `---` and the body.
 * Values are one line each, written plain when that is unambiguous YAML and
 * as a JSON (= YAML double-quoted) string otherwise, so gbrain's YAML parser
 * and parseFrontmatter read the same value.
 */
import { redactSecrets } from "../gateway/core/status-text";

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
  supersedes?: string;
  fields?: Record<string, string>;
}

/** Keys composePage writes itself; a type's fields may not reuse them. */
const COMMON_KEYS = new Set(["type", "as_of", "confidence", "source", "supersedes", "superseded_by"]);

/** Commitment keys, in the order they are written (global constraints). */
const COMMITMENT_KEYS = ["promiser", "beneficiary", "thread", "due", "check", "on_no_change", "status"] as const;
const COMMITMENT_STATUS = new Set(["open", "done", "dropped"]);
const ON_NO_CHANGE = new Set(["close-in-one-line", "silent"]);

export const CREDENTIAL_REFUSAL = "refused: page contains a credential-like value";

const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
/** A value YAML reads back as the same string when written plain. */
const PLAIN_VALUE = /^[A-Za-z0-9_./@<>()+-][A-Za-z0-9 _./@<>()+,-]*$/;
/** Plain-looking values YAML would read as something other than a string. */
const YAML_SPECIAL = /^(?:true|false|null|yes|no|on|off|~|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

function yamlValue(v: string): string {
  if (v !== "" && v.trim() === v && PLAIN_VALUE.test(v) && !YAML_SPECIAL.test(v)) return v;
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
    if (p.confidence !== undefined || p.source !== undefined || p.supersedes !== undefined || p.fields !== undefined) {
      return { error: `refused: confidence, source, supersedes and fields need a type (one of ${PAGE_TYPES.join(", ")})` };
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
  for (const [k, v] of [["source", p.source], ["supersedes", p.supersedes]] as const) {
    if (v !== undefined && /[\r\n]/.test(v)) return { error: `refused: ${k} must be one line of text` };
  }

  const lines = ["---", `type: ${type}`, `as_of: ${isoDate(now)}`];
  if (confidence !== undefined) lines.push(`confidence: ${confidence}`);
  if (p.source !== undefined) lines.push(`source: ${yamlValue(p.source)}`);
  if (p.supersedes !== undefined) lines.push(`supersedes: ${yamlValue(p.supersedes)}`);
  for (const k of fieldOrder) lines.push(`${k}: ${yamlValue(fields[k]!)}`);
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

/**
 * The old page with `superseded_by: <bySlug>` in its frontmatter (replacing
 * an earlier one). Every other byte, the body included, is kept as it was.
 */
export function markSuperseded(oldContent: string, bySlug: string): string {
  const line = `superseded_by: ${yamlValue(bySlug)}`;
  const m = FRONTMATTER.exec(oldContent);
  if (!m) return `---\n${line}\n---\n${oldContent}`;
  const inner = m[1]!.split(/\r?\n/).filter((l) => !/^superseded_by:/.test(l));
  if (inner.length === 1 && inner[0] === "") inner.length = 0;
  return `---\n${[...inner, line].join("\n")}\n---\n${oldContent.slice(m[0].length)}`;
}

/** A frontmatter value from gbrain's parsed JSON, back as one YAML line. */
function jsonFrontmatterValue(v: unknown): string {
  if (typeof v === "string") {
    // YAML reads a bare date as a timestamp; gbrain stores it as midnight UTC.
    const day = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(v);
    return yamlValue(day ? day[1]! : v);
  }
  return JSON.stringify(v);
}

/**
 * A `get_page` result as markdown: a string or `{ content }` as is, or a
 * gbrain page record rebuilt from its frontmatter and compiled truth (and its
 * timeline section below a `---` rule, gbrain's page layout). Null when the
 * result is not a page.
 */
export function pageMarkdown(page: unknown): string | null {
  if (typeof page === "string") return page;
  if (!page || typeof page !== "object") return null;
  const r = page as { content?: unknown; compiled_truth?: unknown; timeline?: unknown; frontmatter?: unknown; type?: unknown; title?: unknown };
  if (typeof r.content === "string") return r.content;
  if (typeof r.compiled_truth !== "string") return null;
  const fm: Record<string, unknown> = r.frontmatter && typeof r.frontmatter === "object" ? { ...(r.frontmatter as Record<string, unknown>) } : {};
  if (fm.type === undefined && typeof r.type === "string" && r.type) fm.type = r.type;
  if (fm.title === undefined && typeof r.title === "string" && r.title) fm.title = r.title;
  const keys = Object.keys(fm).filter((k) => fm[k] !== undefined && fm[k] !== null);
  const head = keys.length > 0 ? `---\n${keys.map((k) => `${k}: ${jsonFrontmatterValue(fm[k])}`).join("\n")}\n---\n` : "";
  const timeline = typeof r.timeline === "string" && r.timeline.trim() ? `\n\n---\n\n${r.timeline}` : "";
  return head + r.compiled_truth + timeline;
}
