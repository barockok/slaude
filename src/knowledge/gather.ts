import { hasPlacePrefix } from "../memory/place-id";
import { brainCall } from "./brain";
import { storeKind, type BrainScope } from "./scope";

/**
 * Per-source candidate gather — the slaude-side fix for the bulk-corpus
 * retrieval-noise problem (cold queries can't find a curated page that a
 * warm-context conversation answers without retrieval).
 *
 * THE PROBLEM. gbrain's `search` op (and `think`'s internal gather) pool every
 * allowed source into ONE ranked candidate set. A high-volume source like a
 * bulk auto-generated corpus (thousands of near-empty `# model / no documented
 * columns` stubs) scores high base-vector on common domain words and *fills the
 * candidate set by sheer count* — so a single curated page in a small source
 * never enters the pool, and the reranker (which correctly tanks the stubs to
 * ~0.06) never gets to sort it up. Verified live: a directory-lookup query
 * gathered 25 pages, ALL 25 bulk stubs; the curated page existed the whole
 * time. See docs/findings/2026-06-15-per-source-gather.md.
 *
 * THE FIX. Fan out one `search` per allowed source (single-source scope each),
 * take the top-K from EACH, then merge and re-rank the union. Now every source
 * — including small curated ones — is *guaranteed* K candidate slots; no source
 * can monopolise the pool by volume. The merged set is re-sorted by gbrain's
 * own `rerank_score` (already computed per hit), so the bulk stubs sink and the
 * curated page surfaces. gbrain stays stock: we only orchestrate its `search` op
 * differently. This is the slaude-side proving ground; once validated the
 * per-source ranking is promoted upstream to gbrain.
 */

export interface GatherHit {
  slug?: string;
  source_id?: string;
  score?: number;
  rerank_score?: number;
  [k: string]: unknown;
}

export interface GatherOpts {
  /** Candidates pulled from EACH source before the merge. Default 8. */
  perSourceK?: number;
  /** Cap on the merged, re-ranked result. Default 20. */
  finalLimit?: number;
  /** Injectable op caller (tests). Default: brainCall. */
  call?: (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;
}

/** Where a hit's source sits relative to the turn, most local first (memory places, rc.47). */
export type SourceKind = "place" | "person" | "persona" | "shared" | "public" | "library";
const KIND_ORDER: readonly SourceKind[] = ["place", "person", "persona", "shared", "public", "library"];

/** The kind of a source id: a place, a person's slice or profile, the persona's own mind, shared, public, or a library wiki. */
export function sourceKindOf(source: string): SourceKind {
  switch (storeKind(source)) {
    case "place":
      return "place";
    case "personal":
    case "profile":
      return "person";
    case "agent":
      return "persona";
    case "shared":
      return "shared";
    case "public":
      return "public";
    default:
      return "library";
  }
}
/**
 * A conversation page is a log of one place's thread, not knowledge. Pages written before a persona's switch to
 * places sit in the persona slice, which every place reads, so a search from another place would return what was
 * said in this one. Under places a conversation page is returned only from the turn's own place source.
 */
const CONVERSATION_SLUG = /^[/.]*conversations(\/|$)/i;

const localityOf = (h: GatherHit): number => KIND_ORDER.indexOf((h.source_kind as SourceKind | undefined) ?? "library");

/** Effective rank: gbrain's reranker output when present, else the base score. */
export function rankScore(h: GatherHit): number {
  if (typeof h.rerank_score === "number") return h.rerank_score;
  if (typeof h.score === "number") return h.score;
  return 0;
}

/** Stable per-hit identity for dedup across per-source result lists. */
function hitKey(h: GatherHit): string {
  if (typeof h.slug === "string" && h.slug) return h.slug;
  if (typeof h.chunk_id === "number") return `chunk:${h.chunk_id}`;
  return JSON.stringify(h);
}

/**
 * Clean retrieval query: collapse excess whitespace and strip trailing punctuation.
 */
export function normalizeQuery(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();
  return cleaned.length > 0 ? cleaned : raw.trim();
}

/**
 * Gather ranked candidates for `query` within `scope`, with each allowed source
 * guaranteed its own top-K slots. When the scope writes a memory place (memory places on), the place source is
 * searched first, equal scores are broken by locality (place, person, persona-wide, shared, public, library) and every
 * hit carries `source_kind`; any other scope is merged exactly as before. Returns hits sorted by effective rank, deduped
 * by slug (best-ranked chunk per page wins), capped at finalLimit.
 */
export async function gather(query: string, scope: BrainScope, opts: GatherOpts = {}): Promise<GatherHit[]> {
  const perSourceK = opts.perSourceK ?? 8;
  const finalLimit = opts.finalLimit ?? 20;
  const call = opts.call ?? brainCall;
  const targetQuery = normalizeQuery(query);

  const base = scope.allowedSources.length > 0 ? scope.allowedSources : [scope.sourceId];
  // Locality applies only to a scope that writes a place: with the mode off or shadow the scope writes the persona
  // slice, so the order, the merge and the hits are unchanged.
  const local = hasPlacePrefix(scope.sourceId);
  const sources = local ? [...base].sort((a, b) => KIND_ORDER.indexOf(sourceKindOf(a)) - KIND_ORDER.indexOf(sourceKindOf(b))) : base;

  // One search per source, scoped to that source alone, in parallel. A single
  // source failing (e.g. transient) drops to [] rather than sinking the gather
  // — BUT if EVERY source fails the brain is genuinely down, so we rethrow so
  // the handler maps it to an error rather than papering over it with []
  // (see the no-silent-success rule in 2026-06-14-brain-memoize-failure.md).
  let lastErr: unknown;
  let failures = 0;
  const perSource = await Promise.all(
    sources.map(async (s): Promise<GatherHit[]> => {
      const sub: BrainScope = { clientId: scope.clientId, sourceId: s, allowedSources: [s], ...(scope.placeAgent ? { placeAgent: scope.placeAgent } : {}) };
      try {
        const hits = await call("search", { query: targetQuery, limit: perSourceK }, sub);
        if (!Array.isArray(hits)) return [];
        if (!local) return hits as GatherHit[];
        return (hits as GatherHit[])
          .filter((h) => s === scope.sourceId || typeof h.slug !== "string" || !CONVERSATION_SLUG.test(h.slug.trim()))
          .map((h) => ({ ...h, source_id: h.source_id ?? s, source_kind: sourceKindOf(s) }));
      } catch (e) {
        failures++;
        lastErr = e;
        return [];
      }
    }),
  );
  if (failures === sources.length && sources.length > 0) throw lastErr;

  // Merge: dedup by slug, keeping the highest-ranked chunk for each page.
  const best = new Map<string, GatherHit>();
  for (const hits of perSource) {
    for (const h of hits) {
      const key = hitKey(h);
      const prev = best.get(key);
      if (!prev || rankScore(h) > rankScore(prev) || (local && rankScore(h) === rankScore(prev) && localityOf(h) < localityOf(prev))) best.set(key, h);
    }
  }

  return [...best.values()].sort((a, b) => rankScore(b) - rankScore(a) || (local ? localityOf(a) - localityOf(b) : 0)).slice(0, finalLimit);
}
