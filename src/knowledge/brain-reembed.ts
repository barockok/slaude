import {
  allowEmbeddingRealign,
  configuredEmbeddingModel,
  embeddingActive,
  embeddingRefusal,
  getBrain,
  runAdminOp,
} from "./brain";
import { brainMode } from "./brain-config";
import { normalizeEmbeddingModel } from "./embedding-guard";

/**
 * Repair for chunks whose embedding model label differs from the configured
 * model (`slaude brain reembed --model-mismatch`). Every step goes through
 * gbrain's own APIs: sources_list, engine.listPages / getChunks / upsertChunks /
 * setPageEmbeddingSignature / getConfig / setConfig, and gbrain's embedBatch. No
 * SQL on gbrain tables. Dry run unless `apply`.
 *
 * A page with any mismatched chunk is re-embedded whole, so its embedding
 * signature can be stamped honestly. When the brain's own record
 * (config.embedding_model) names another model, every chunk is suspect and
 * every page is re-embedded; the record is then set to the configured model.
 */

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

type ChunkRow = {
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  model: string | null;
  embedding: unknown;
  language?: string | null;
  symbol_name?: string | null;
  symbol_type?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  parent_symbol_path?: string[] | null;
  doc_comment?: string | null;
  symbol_name_qualified?: string | null;
};

export type ReembedEngine = {
  listPages(f: { sourceId: string; limit: number; offset: number; sort: "slug" }): Promise<Array<{ slug: string }>>;
  getChunks(slug: string, o: { sourceId: string }): Promise<ChunkRow[]>;
  upsertChunks(slug: string, chunks: object[], o: { sourceId: string }): Promise<void>;
  setPageEmbeddingSignature(slug: string, o: { sourceId: string; signature: string }): Promise<void>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
};

export interface ReembedPage {
  sourceId: string;
  slug: string;
  chunks: number;
  mismatched: number;
}

export interface ReembedReport {
  target: string;
  brainModel: string | null;
  apply: boolean;
  /** Chunk count per label found on mismatched chunks. */
  byModel: Record<string, number>;
  pages: ReembedPage[];
  chunksMismatched: number;
  pagesReembedded: number;
  chunksReembedded: number;
  errors: Array<{ sourceId: string; slug: string; error: string }>;
  brainModelUpdated: boolean;
}

export interface ReembedDeps {
  engine: ReembedEngine;
  target: string;
  targetDims: number | null;
  sourceIds: string[];
  embed(texts: string[]): Promise<Float32Array[]>;
  signature(): string;
  log?(m: string): void;
}

const PAGE = 500;

/** The pure core: plan, and with `apply` re-embed, against an engine. */
export async function reembedModelMismatch(d: ReembedDeps, apply: boolean): Promise<ReembedReport> {
  const log = d.log ?? (() => {});
  const target = normalizeEmbeddingModel(d.target)!;
  const brainModel = normalizeEmbeddingModel(await d.engine.getConfig("embedding_model"));
  const wholeBrain = brainModel !== null && brainModel !== target;
  const report: ReembedReport = {
    target, brainModel, apply, byModel: {}, pages: [], chunksMismatched: 0,
    pagesReembedded: 0, chunksReembedded: 0, errors: [], brainModelUpdated: false,
  };
  if (wholeBrain) log(`brain record names ${brainModel}, configured is ${target}: every chunk is re-embedded`);

  for (const sourceId of d.sourceIds) {
    for (let offset = 0; ; offset += PAGE) {
      const pages = await d.engine.listPages({ sourceId, limit: PAGE, offset, sort: "slug" });
      for (const { slug } of pages) {
        const chunks = await d.engine.getChunks(slug, { sourceId });
        const bad = chunks.filter((c) => wholeBrain || normalizeEmbeddingModel(c.model) !== target);
        if (bad.length === 0) continue;
        for (const c of bad) {
          const m = normalizeEmbeddingModel(c.model) ?? "(none)";
          report.byModel[m] = (report.byModel[m] ?? 0) + 1;
        }
        report.chunksMismatched += bad.length;
        report.pages.push({ sourceId, slug, chunks: chunks.length, mismatched: bad.length });
        if (!apply) continue;
        try {
          const vectors = await d.embed(chunks.map((c) => c.chunk_text));
          await d.engine.upsertChunks(
            slug,
            chunks.map((c, i) => ({
              chunk_index: c.chunk_index,
              chunk_text: c.chunk_text,
              chunk_source: c.chunk_source,
              embedding: vectors[i],
              model: target,
              token_count: Math.ceil(c.chunk_text.length / 4),
              language: c.language ?? null,
              symbol_name: c.symbol_name ?? null,
              symbol_type: c.symbol_type ?? null,
              start_line: c.start_line ?? null,
              end_line: c.end_line ?? null,
              parent_symbol_path: c.parent_symbol_path ?? null,
              doc_comment: c.doc_comment ?? null,
              symbol_name_qualified: c.symbol_name_qualified ?? null,
            })),
            { sourceId },
          );
          await d.engine.setPageEmbeddingSignature(slug, { sourceId, signature: d.signature() });
          report.pagesReembedded++;
          report.chunksReembedded += chunks.length;
          log(`re-embedded ${sourceId}/${slug} (${chunks.length} chunks)`);
        } catch (e) {
          report.errors.push({ sourceId, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (pages.length < PAGE) break;
    }
  }

  if (apply && wholeBrain && report.errors.length === 0) {
    await d.engine.setConfig("embedding_model", target);
    if (d.targetDims) await d.engine.setConfig("embedding_dimensions", String(d.targetDims));
    report.brainModelUpdated = true;
    log(`brain record set to ${target}`);
  }
  return report;
}

/**
 * The command: boots the local brain with this process's EMBEDDING_* config
 * and runs the repair. Refuses where it cannot do the job right: a remote-mode
 * client (run it where the brain engine lives), no configured model, a
 * dimension mismatch (a column migration, not a re-embed), or, with apply, no
 * working embedding gateway.
 */
export async function runReembedCommand(o: { apply: boolean; sourceIds?: string[]; log?: (m: string) => void }): Promise<ReembedReport> {
  if (brainMode() === "remote") {
    throw new Error("SLAUDE_BRAIN_MODE=remote: run this where the brain engine runs (the brain server)");
  }
  allowEmbeddingRealign(true);
  const engine = (await getBrain()) as unknown as ReembedEngine;
  const target = configuredEmbeddingModel();
  if (!target) throw new Error("no embedding model configured in this process: set EMBEDDING_PROVIDER / EMBEDDING_MODEL as on the gateway");
  const refusal = embeddingRefusal();
  if (refusal) throw new Error(refusal);
  const targetDims = Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) || null;
  const storedDims = Number(await engine.getConfig("embedding_dimensions")) || null;
  if (storedDims && targetDims && storedDims !== targetDims) {
    throw new Error(`brain embedding_dimensions is ${storedDims}, configured is ${targetDims}: re-embedding cannot change the vector column width`);
  }
  if (o.apply && !embeddingActive()) {
    throw new Error("embedding gateway inactive (provider key missing?): cannot re-embed");
  }
  const sourceIds =
    o.sourceIds && o.sourceIds.length > 0
      ? o.sourceIds
      : ((await runAdminOp("sources_list", {})) as { sources: Array<{ id: string }> }).sources.map((s) => s.id);
  const { embedBatch, currentEmbeddingSignature } = (await gbrainImport("embedding")) as {
    embedBatch: (t: string[]) => Promise<Float32Array[]>;
    currentEmbeddingSignature: () => string;
  };
  return reembedModelMismatch(
    { engine, target, targetDims, sourceIds, embed: embedBatch, signature: currentEmbeddingSignature, log: o.log },
    o.apply,
  );
}

export function formatReembedReport(r: ReembedReport): string {
  const lines = [
    `configured model: ${r.target}; brain record: ${r.brainModel ?? "(none)"}`,
    `mismatched chunks: ${r.chunksMismatched} on ${r.pages.length} page(s)`,
  ];
  for (const [m, n] of Object.entries(r.byModel)) lines.push(`  label ${m}: ${n}`);
  for (const p of r.pages.slice(0, 50)) lines.push(`  ${p.sourceId}/${p.slug}: ${p.mismatched}/${p.chunks}`);
  if (r.pages.length > 50) lines.push(`  ... ${r.pages.length - 50} more`);
  if (!r.apply) {
    lines.push("dry run: nothing changed. Re-run with --apply to re-embed these pages with the configured model.");
  } else {
    lines.push(`re-embedded ${r.chunksReembedded} chunk(s) on ${r.pagesReembedded} page(s)`);
    if (r.brainModelUpdated) lines.push(`brain record set to ${r.target}`);
    for (const e of r.errors) lines.push(`  FAILED ${e.sourceId}/${e.slug}: ${e.error}`);
  }
  return lines.join("\n");
}
