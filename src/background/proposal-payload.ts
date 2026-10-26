/**
 * What a team-fact or promote proposal would write, and the guards that hold
 * for it (Task 9 fix round 1). The same refusals as the pass's own memoize
 * apply, both when the pass proposes (so a bad payload never becomes a card)
 * and again when a card is approved (rows written before this check, or by
 * anything else, are refused too):
 *   - no `conversations/…` page (a transcript or its summary);
 *   - no lessons page (`self/lessons`, `self/lesson-proposals`): only the
 *     lessons upkeep writes them, and a lessons page is at most 40 lines;
 *   - no `profile` page (a profile is written only by its person);
 *   - nothing that looks like a credential.
 */
import { redactSecrets } from "../gateway/core/status-text";
import { CREDENTIAL_REFUSAL } from "../knowledge/memory-pages";
import type { KbMemoizeArgs, MemoizeTarget } from "../knowledge/mcp-tools";
import type { Proposal } from "../db/proposals";

/** A `lessons` page holds at most this many lines (global constraints). */
export const LESSONS_MAX_LINES = 40;
/** The agent's lessons page and its proposals page (lessons-upkeep.ts names them from here). */
export const LESSONS_PAGE_SLUG = "self/lessons";
export const LESSON_PROPOSALS_PAGE_SLUG = "self/lesson-proposals";

export const LESSONS_REFUSAL = `refused: a lessons page holds at most ${LESSONS_MAX_LINES} lines; merge or drop lessons before adding`;
export const CONVERSATION_REFUSAL = "refused: conversation pages and their summaries are never written with memoize";
export const LESSONS_PAGE_REFUSAL = "refused: the lessons pages are written only by the lessons upkeep";
export const PROFILE_PAGE_REFUSAL = "refused: a profile is written only by that person, never through a proposal";

/** Most pages one approved proposal writes. */
export const MAX_PROPOSAL_PAGES = 5;

export const SLUG_SEGMENT_REFUSAL = "refused: a slug may not hold a '.' or '..' segment or a backslash";

/**
 * True for a slug with a `.` or `..` path segment or a backslash: if the
 * brain normalised those, `people/../conversations/<s>` would name a
 * transcript and `x/../self/lessons` the lessons page past the guards below.
 */
export const hasDotSegment = (slug: string): boolean => slug.includes("\\") || slug.trim().split("/").some((seg) => seg === "." || seg === "..");

export const lineCount = (s: string): number => s.replace(/\s+$/, "").split(/\r?\n/).length;
export const isConversationSlug = (slug: string): boolean => /^[/.]*conversations(\/|$)/i.test(slug.trim());
const normSlug = (slug: string): string => slug.trim().replace(/^[/.]+/, "").replace(/\/+$/, "").toLowerCase();

/**
 * True when any string in `v` (recursively, keys included) looks like a
 * credential: the string alone, and each object entry rendered as `key: value`,
 * since JSON's `"api_key":"…"` shape is not what redactSecrets matches.
 */
export function holdsCredential(v: unknown, key?: string): boolean {
  if (typeof v === "string") {
    if (redactSecrets(v) !== v) return true;
    return key !== undefined && redactSecrets(`${key}: ${v}`) !== `${key}: ${v}`;
  }
  if (typeof v === "number" || typeof v === "boolean") return key !== undefined && holdsCredential(String(v), key);
  if (Array.isArray(v)) return v.some((x) => holdsCredential(x, key));
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => holdsCredential(k) || holdsCredential(x, k));
  }
  return false;
}

type PageArg = KbMemoizeArgs["pages"][number];
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** Why one proposed page may not be written, or null. */
function pageRefusal(pg: PageArg): string | null {
  if (hasDotSegment(pg.slug)) return SLUG_SEGMENT_REFUSAL;
  if (isConversationSlug(pg.slug)) return CONVERSATION_REFUSAL;
  const slug = normSlug(pg.slug);
  if (slug === LESSONS_PAGE_SLUG || slug === LESSON_PROPOSALS_PAGE_SLUG) return LESSONS_PAGE_REFUSAL;
  if (pg.type === "lessons" && lineCount(pg.content) > LESSONS_MAX_LINES) return LESSONS_REFUSAL;
  if (pg.type === "profile" || slug === "profile") return PROFILE_PAGE_REFUSAL;
  return null;
}

/** The write an approved team-fact or promote proposal makes, or why it cannot be made. */
export function proposalWrite(p: Pick<Proposal, "kind" | "payload">): { pages: PageArg[]; target: MemoizeTarget } | { error: string } {
  const pl = p.payload;
  if (holdsCredential(pl)) return { error: CREDENTIAL_REFUSAL };
  const raw: unknown[] = Array.isArray(pl.pages) ? pl.pages : pl.page !== undefined ? [pl.page] : str(pl.slug) ? [pl] : [];
  if (raw.length === 0) return { error: "this proposal carries no page to write" };
  if (raw.length > MAX_PROPOSAL_PAGES) return { error: `this proposal carries over ${MAX_PROPOSAL_PAGES} pages` };
  const pages: PageArg[] = [];
  for (const r of raw) {
    const g = (r ?? {}) as Record<string, unknown>;
    const slug = str(g.slug);
    const content = typeof g.content === "string" ? g.content : undefined;
    if (!slug || content === undefined) return { error: "a page in this proposal has no slug or content" };
    const fields = g.fields && typeof g.fields === "object" && !Array.isArray(g.fields)
      ? Object.fromEntries(Object.entries(g.fields as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : undefined;
    const page = {
      slug,
      content,
      summary: str(g.summary) ?? str(pl.summary) ?? slug,
      type: str(g.type) ?? (p.kind === "team-fact" ? "team-fact" : undefined),
      ...(str(g.confidence) ? { confidence: str(g.confidence)! } : {}),
      ...(str(g.source) ? { source: str(g.source)! } : {}),
      ...(str(g.subject) ? { subject: str(g.subject)! } : {}),
      ...(fields ? { fields } : {}),
    } as PageArg;
    const refused = pageRefusal(page);
    if (refused) return { error: refused };
    pages.push(page);
  }
  if (p.kind === "team-fact") return { pages, target: "shared" };
  // A promotion goes to shared unless it names the agent's own slice.
  return { pages, target: pl.target === "agent" ? "mine" : "shared" };
}

/** At propose time: why this payload must not be queued, or null. Only kinds that write are checked for pages. */
export function proposalPayloadError(kind: string, payload: Record<string, unknown>): string | null {
  if (holdsCredential(payload)) return CREDENTIAL_REFUSAL;
  if (kind !== "team-fact" && kind !== "promote") return null;
  const w = proposalWrite({ kind: kind as Proposal["kind"], payload });
  return "error" in w ? w.error : null;
}
