/**
 * Embedding model guard. Two problems, one module:
 *
 * 1. gbrain labels every chunk it writes with `chunk.model || DEFAULT_EMBEDDING_MODEL`
 *    (its compiled-in default, `zeroentropyai:zembed-1`), and none of its own
 *    writers (put_page, sync, `embed --stale`) set `chunk.model`. So a chunk
 *    embedded by the configured provider is still labelled with gbrain's
 *    default. installChunkModelStamp makes the label describe the vector.
 *
 * 2. A process whose embedding config differs from the brain's record (the
 *    `config` table's embedding_model and embedding_dimensions) could put
 *    vectors from a second model into one column, which breaks search. The
 *    record is not proof by itself: brains created while gbrain's gateway was
 *    unconfigured at schema time carry gbrain's seeded default there while
 *    every vector came from the configured model. classifyEmbeddingRecord says
 *    whether the record matches, differs only in the provider prefix (adopt),
 *    needs a probe of stored vectors (probeEmbeddingRecord), or cannot match.
 */

/** Legacy gbrain wrote bare OpenAI model names; gbrain itself reads them as `openai:<name>`. */
export function normalizeEmbeddingModel(model: string | null | undefined): string | null {
  const m = model?.trim();
  if (!m) return null;
  return m.includes(":") ? m : `openai:${m}`;
}

/** The model name without its provider prefix (`openai:x` and `litellm:x` are both `x`). */
export function bareEmbeddingModel(model: string): string {
  const i = model.indexOf(":");
  return i < 0 ? model : model.slice(i + 1);
}

export interface EmbeddingGuardInput {
  /** The model this process resolved from EMBEDDING_* / config.json (null: none). */
  configured: string | null;
  configuredDims: number | null;
  /** The brain's own record (the `config` table). */
  stored: string | null;
  storedDims: number | null;
  /** The model the AI gateway would embed with (null: gateway not configured). */
  gateway: string | null;
}

export type EmbeddingRecordVerdict =
  | { kind: "ok" }
  /** Same model name and dimensions, another provider prefix: adopt the configured name. */
  | { kind: "adopt"; from: string; to: string }
  /** Another model name: only stored vectors can tell (probeEmbeddingRecord). */
  | { kind: "probe"; from: string; to: string }
  | { kind: "refuse"; message: string };

/**
 * Judge this process's embedding config against the brain's record. Only a
 * configured process is judged: one with no embedding config never embeds
 * (gbrain's put_page skips embedding when the gateway is unavailable).
 */
export function classifyEmbeddingRecord(i: EmbeddingGuardInput): EmbeddingRecordVerdict {
  const configured = normalizeEmbeddingModel(i.configured);
  if (!configured) return { kind: "ok" };
  const gateway = normalizeEmbeddingModel(i.gateway);
  if (gateway && gateway !== configured) {
    return { kind: "refuse", message: `embedding gateway model ${gateway} differs from the configured ${configured}` };
  }
  if (i.storedDims && i.configuredDims && i.storedDims !== i.configuredDims) {
    return {
      kind: "refuse",
      message: `brain embedding_dimensions is ${i.storedDims} but this process is configured for ${i.configuredDims}`,
    };
  }
  const stored = normalizeEmbeddingModel(i.stored);
  if (!stored || stored === configured) return { kind: "ok" };
  if (bareEmbeddingModel(stored) === bareEmbeddingModel(configured)) return { kind: "adopt", from: stored, to: configured };
  return { kind: "probe", from: stored, to: configured };
}

export const EMBED_REFUSAL_HINT =
  "embeds are OFF in this process (writes land unembedded). Align EMBEDDING_PROVIDER / EMBEDDING_MODEL / " +
  "EMBEDDING_DIMENSIONS with the brain, re-embed with `slaude brain reembed --model-mismatch`, or, when the " +
  "stored vectors are known to come from the configured model, record it with `slaude brain reembed --adopt`.";

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export type ProbeSort = "updated_asc" | "updated_desc" | "slug";

export interface ProbeEngine {
  listAllSources(): Promise<Array<{ id: string }>>;
  listPages(f: { sourceId: string; limit: number; offset: number; sort: ProbeSort }): Promise<Array<{ slug: string; title?: string | null }>>;
  getChunksWithEmbeddings(
    slug: string,
    o: { sourceId: string },
  ): Promise<Array<{ chunk_text: string; chunk_source: string; embedding: ArrayLike<number> | null; model?: string | null }>>;
}

export interface ProbeOptions {
  embed(texts: string[]): Promise<ArrayLike<number>[]>;
  /** The embedding input gbrain's import used for a chunk under the title tier (null: same as plain). */
  wrap?(title: string, text: string, chunkSource: string): string | null;
  /** gbrain's default chunk label; it says nothing about the vector, so it never counts as a model. */
  defaultLabel?: string;
  samples?: number;
  maxPages?: number;
  timeoutMs?: number;
  threshold?: number;
  /**
   * Wraps the database phase (sampling) so a caller can register it as brain
   * work: a close then waits for these short reads, never for the provider.
   */
  trackDbWork?<T>(p: Promise<T>): Promise<T>;
  /** Checked between page reads: true stops the sampling (the brain is closing). */
  shouldStop?(): boolean;
}

export type ProbeResult =
  | { status: "match"; samples: number; min: number }
  | { status: "mismatch"; samples: number; min: number }
  /** The chunk labels already name two or more models: never adopted automatically. */
  | { status: "mixed"; labels: string[] }
  | { status: "empty"; samples: 0 }
  | { status: "error"; error: string };

const PROBE_SORTS: readonly ProbeSort[] = ["updated_asc", "updated_desc", "slug"];

/**
 * Re-embed stored chunk texts with the gateway and compare with their stored
 * vectors, to tell whether a brain's vectors came from the configured model.
 * A brain may be mixed (an older model on older pages, a same-width model on
 * newer ones), so the samples are spread: at most one chunk per page, pages
 * taken round-robin from every source and from both ends of the update
 * history (updated_asc, updated_desc) plus slug order. Every sample must
 * reach `threshold` cosine (plain or title-wrapped input: gbrain's default
 * contextual-retrieval tier wraps the embedding input); one miss is a
 * mismatch. Chunk labels naming two or more models other than gbrain's
 * default are "mixed", never a match. Bounded by `timeoutMs` and `maxPages`;
 * any failure (including the timeout) is "error", never a verdict.
 */
export async function probeEmbeddingRecord(engine: ProbeEngine, o: ProbeOptions): Promise<ProbeResult> {
  const want = o.samples ?? 6;
  const maxPages = o.maxPages ?? 60;
  const threshold = o.threshold ?? 0.99;
  const defaultLabel = normalizeEmbeddingModel(o.defaultLabel);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "error", error: `probe timed out after ${o.timeoutMs ?? 20_000}ms` }), o.timeoutMs ?? 20_000);
    (timer as { unref?: () => void }).unref?.();
  });
  type Sample = { stored: ArrayLike<number>; inputs: string[] };
  const sample = async (): Promise<{ picked: Sample[]; labels: Set<string> } | null> => {
    // One short list per (source, order); interleaved so the first samples
    // already cover every source and both ends of the history.
    const perList = Math.max(1, Math.ceil(want / PROBE_SORTS.length));
    type Listed = Array<{ sourceId: string; slug: string; title: string }>;
    const grid: Listed[][] = [];
    for (const { id } of await engine.listAllSources()) {
      const row: Listed[] = [];
      for (const sort of PROBE_SORTS) {
        const pages = await engine.listPages({ sourceId: id, limit: perList * 4, offset: 0, sort });
        row.push(pages.map((p) => ({ sourceId: id, slug: p.slug, title: p.title ?? "" })));
      }
      grid.push(row);
    }
    // Visit sources first, rotating the order per source, so with many
    // sources the first samples already span sources and both ends of the
    // history instead of using up the budget on the first one or two.
    const lists: Listed[] = [];
    for (let p = 0; p < PROBE_SORTS.length; p++) {
      for (let k = 0; k < grid.length; k++) lists.push(grid[k]![(k + p) % PROBE_SORTS.length]!);
    }
    const seen = new Set<string>();
    const order: Array<{ sourceId: string; slug: string; title: string }> = [];
    for (let i = 0; order.length < maxPages && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const p = l[i];
        if (!p || seen.has(`${p.sourceId}\u0000${p.slug}`)) continue;
        seen.add(`${p.sourceId}\u0000${p.slug}`);
        order.push(p);
        if (order.length >= maxPages) break;
      }
    }
    const picked: Sample[] = [];
    const labels = new Set<string>();
    for (const p of order) {
      if (picked.length >= want) break;
      if (o.shouldStop?.()) return null;
      const chunks = await engine.getChunksWithEmbeddings(p.slug, { sourceId: p.sourceId });
      for (const c of chunks) {
        const label = normalizeEmbeddingModel(c.model);
        if (label && label !== defaultLabel && c.embedding) labels.add(label);
      }
      const c = chunks.find((x) => x.embedding && x.embedding.length > 0);
      if (!c) continue;
      const wrapped = o.wrap?.(p.title, c.chunk_text, c.chunk_source) ?? null;
      picked.push({ stored: c.embedding!, inputs: wrapped && wrapped !== c.chunk_text ? [c.chunk_text, wrapped] : [c.chunk_text] });
    }
    return { picked, labels };
  };
  const run = async (): Promise<ProbeResult> => {
    const sampled = await (o.trackDbWork ? o.trackDbWork(sample()) : sample());
    if (!sampled) return { status: "error", error: "stopped: the brain is closing" };
    const { picked, labels } = sampled;
    if (labels.size >= 2) return { status: "mixed", labels: [...labels].sort() };
    if (picked.length === 0) return { status: "empty", samples: 0 };
    const vectors = await o.embed(picked.flatMap((s) => s.inputs));
    let at = 0;
    let min = 1;
    for (const s of picked) {
      let best = -1;
      for (let k = 0; k < s.inputs.length; k++) best = Math.max(best, cosineSimilarity(s.stored, vectors[at++] ?? []));
      min = Math.min(min, best);
    }
    return { status: min >= threshold ? "match" : "mismatch", samples: picked.length, min };
  };
  try {
    return await Promise.race([
      run().catch((e): ProbeResult => ({ status: "error", error: e instanceof Error ? e.message : String(e) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pass this in upsertChunks' options when the chunks were carried in from
 * elsewhere (a bundle import): their vectors were not made by this process's
 * gateway, so their labels are kept. The stamp removes the flag before gbrain
 * sees the options.
 */
export const CARRIED_IN = "slaudeCarriedIn";

type ChunkLike = { model?: string; embedding?: unknown; modality?: string } & Record<string, unknown>;
type UpsertChunks = (this: unknown, slug: string, chunks: ChunkLike[], opts?: Record<string, unknown>) => Promise<unknown>;

const STAMPED = Symbol.for("slaude.chunkModelStamp");

export interface ChunkStampDeps {
  /**
   * The label for this process's writes (null: leave gbrain's label). The
   * configured model only when this process can embed and the guard did not
   * refuse; otherwise the brain's recorded model.
   */
  labelModel(): string | null;
  /** The gateway's current embedding model (null: not configured). */
  gatewayModel(): string | null;
  /** Where the refusal is logged. Default console.error. */
  onRefuse?(message: string): void;
}

/**
 * Wrap engine.upsertChunks (an own property, so gbrain's transaction engines,
 * created with Object.create(engine), inherit it). Unless the call is marked
 * CARRIED_IN, every text chunk with a vector is taken as made by this
 * process's gateway, whatever label it arrives with: it is labelled with the
 * gateway's model when that is the label model, and otherwise written without
 * its vector (never with a second model). Chunks without a vector get the
 * label model. Carried-in chunks keep their labels (unlabelled ones get the
 * label model). Image chunks (modality 'image', a separate vector column) are
 * left as they are. Idempotent.
 */
export function installChunkModelStamp(engine: object, deps: ChunkStampDeps): void {
  const e = engine as { upsertChunks?: UpsertChunks; [STAMPED]?: true };
  if (typeof e.upsertChunks !== "function" || e[STAMPED]) return;
  const original = e.upsertChunks;
  const refuse = deps.onRefuse ?? ((m: string) => console.error(`[brain] ${m}`));
  e.upsertChunks = function (this: unknown, slug: string, chunks: ChunkLike[], opts?: Record<string, unknown>) {
    let gbrainOpts = opts;
    let carried = false;
    if (opts && CARRIED_IN in opts) {
      const { [CARRIED_IN]: flag, ...rest } = opts;
      carried = flag === true;
      gbrainOpts = rest;
    }
    const label = normalizeEmbeddingModel(deps.labelModel());
    if (!label) return original.call(this, slug, chunks, gbrainOpts);
    const gateway = normalizeEmbeddingModel(deps.gatewayModel());
    let refused = false;
    const out = chunks.map((c) => {
      if (c.modality === "image") return c;
      if (carried) return c.model ? c : { ...c, model: label };
      if (c.embedding) {
        if (gateway && gateway === label) return { ...c, model: gateway };
        refused = true;
        const { embedding: _dropped, ...rest } = c;
        return { ...rest, model: label };
      }
      return { ...c, model: label };
    });
    if (refused) {
      refuse(
        `REFUSED an embedding for ${slug}: gateway model ${gateway ?? "(none)"} is not the label model ${label}; ` +
          "the chunks are written unembedded",
      );
    }
    return original.call(this, slug, out, gbrainOpts);
  };
  Object.defineProperty(e, STAMPED, { value: true });
}
