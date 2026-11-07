/**
 * Embedding model guard. Two problems, one module:
 *
 * 1. gbrain labels every chunk it writes with `chunk.model || DEFAULT_EMBEDDING_MODEL`
 *    (its compiled-in default, `zeroentropyai:zembed-1`), and none of its own
 *    writers (put_page, sync, `embed --stale`) set `chunk.model`. So a chunk
 *    embedded by the configured provider is still labelled with gbrain's
 *    default, and the label cannot tell which model produced a vector.
 *    installChunkModelStamp fills the label with the brain's configured model.
 *
 * 2. A process whose embedding config differs from the brain's (the `config`
 *    table's embedding_model and embedding_dimensions, written when the schema
 *    was created) would put vectors from a second model into one column, which
 *    breaks search. embeddingGuardVerdict names that case; the boot refuses to
 *    embed on it, and the stamp strips any vector that the gateway produced
 *    with another model (the write lands unembedded, for a later embed pass).
 */

/** Legacy gbrain wrote bare OpenAI model names; gbrain itself reads them as `openai:<name>`. */
export function normalizeEmbeddingModel(model: string | null | undefined): string | null {
  const m = model?.trim();
  if (!m) return null;
  return m.includes(":") ? m : `openai:${m}`;
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

/**
 * Null when this process may embed into this brain, else the refusal text.
 * Only a configured process is judged: one with no embedding config never
 * embeds (gbrain's put_page skips embedding when the gateway is unavailable).
 */
export function embeddingGuardVerdict(i: EmbeddingGuardInput): string | null {
  const configured = normalizeEmbeddingModel(i.configured);
  if (!configured) return null;
  const gateway = normalizeEmbeddingModel(i.gateway);
  if (gateway && gateway !== configured) {
    return `embedding gateway model ${gateway} differs from the configured ${configured}`;
  }
  const stored = normalizeEmbeddingModel(i.stored);
  if (stored && stored !== configured) {
    return `brain embedding_model is ${stored} but this process is configured for ${configured}`;
  }
  if (i.storedDims && i.configuredDims && i.storedDims !== i.configuredDims) {
    return `brain embedding_dimensions is ${i.storedDims} but this process is configured for ${i.configuredDims}`;
  }
  return null;
}

export const EMBED_REFUSAL_HINT =
  "embeds are OFF in this process (writes land unembedded). Align EMBEDDING_PROVIDER / EMBEDDING_MODEL / " +
  "EMBEDDING_DIMENSIONS with the brain, or re-embed with `slaude brain reembed --model-mismatch`.";

type ChunkLike = { model?: string; embedding?: unknown } & Record<string, unknown>;
type UpsertChunks = (this: unknown, slug: string, chunks: ChunkLike[], opts?: unknown) => Promise<unknown>;

const STAMPED = Symbol.for("slaude.chunkModelStamp");

export interface ChunkStampDeps {
  /** The model chunks of this brain are labelled with (null: leave gbrain's label). */
  brainModel(): string | null;
  /** The gateway's current embedding model (null: not configured). */
  gatewayModel(): string | null;
  /** Where the refusal is logged. Default console.error. */
  onRefuse?(message: string): void;
}

/**
 * Wrap engine.upsertChunks (an own property, so gbrain's transaction engines,
 * created with Object.create(engine), inherit it). Every chunk without a label
 * gets the brain's model. A chunk the gateway just embedded (vector present,
 * no label) under a model other than the brain's loses its vector: it is
 * written unembedded, never with a second model. Chunks that arrive with an
 * explicit label (a bundle import) keep it, and with no gateway configured a
 * vector can only have been carried in, so it is kept. Idempotent.
 */
export function installChunkModelStamp(engine: object, deps: ChunkStampDeps): void {
  const e = engine as { upsertChunks?: UpsertChunks; [STAMPED]?: true };
  if (typeof e.upsertChunks !== "function" || e[STAMPED]) return;
  const original = e.upsertChunks;
  const refuse = deps.onRefuse ?? ((m: string) => console.error(`[brain] ${m}`));
  e.upsertChunks = function (this: unknown, slug: string, chunks: ChunkLike[], opts?: unknown) {
    const brain = normalizeEmbeddingModel(deps.brainModel());
    if (!brain) return original.call(this, slug, chunks, opts);
    let refused = false;
    // No gateway: this process embeds nothing, so a vector here was carried in
    // (a bundle import, checked against the brain's dimensions there).
    const gateway = normalizeEmbeddingModel(deps.gatewayModel());
    const out = chunks.map((c) => {
      if (c.model) return c;
      if (c.embedding && gateway && gateway !== brain) {
        refused = true;
        const { embedding: _dropped, ...rest } = c;
        return { ...rest, model: brain };
      }
      return { ...c, model: brain };
    });
    if (refused) {
      refuse(
        `REFUSED an embedding for ${slug}: gateway model ${gateway} is not the brain's ${brain}; ` +
          "the chunks are written unembedded",
      );
    }
    return original.call(this, slug, out, opts);
  };
  Object.defineProperty(e, STAMPED, { value: true });
}
