import { allowEmbeddingRealign, configuredEmbeddingModel, embeddingActive, getBrain, runAdminOp } from "./brain";
import { brainMode } from "./brain-config";
import { normalizeEmbeddingModel } from "./embedding-guard";

/**
 * Repairs for a brain whose chunk labels or record disagree with the
 * configured embedding model. Dry run unless `apply`.
 *
 * `slaude brain reembed --model-mismatch`: re-embed every page with a text
 * chunk labelled with another model, whole, with the configured model. When
 * the brain's record (config.embedding_model) names another model, every page
 * is suspect and re-embedded, and the record is set once all are done. A
 * whole-brain run resumes: a page already labelled with the target whose
 * embedding signature is current is skipped.
 *
 * `slaude brain reembed --adopt`: record-only. Sets config.embedding_model to
 * the configured model without touching a vector, for an operator who knows
 * the stored vectors came from it.
 *
 * gbrain APIs throughout: listAllSources (via sources_list), listPages
 * (includeDeleted, so soft-deleted pages inside gbrain's purge window are
 * repaired too), getChunks, transaction, upsertChunks,
 * setPageEmbeddingSignature, getConfig / setConfig, embedBatch. One read is
 * raw SQL because gbrain offers no API for it: a page's embedding_signature
 * and its chunks' modality (rowToPage and rowToChunk drop both). It is a
 * read-only SELECT on one page; nothing is written with SQL.
 *
 * A gateway running beside the repair (shared Postgres) is fine: the vectors
 * are computed first, then the page's chunk texts are re-read inside the
 * write transaction and the page is skipped when they changed meanwhile (the
 * gateway's own write then stands, labelled by the same stamp).
 */

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

type ChunkRow = {
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  model: string | null;
  token_count?: number | null;
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
  listPages(f: { sourceId: string; limit: number; offset: number; sort: "slug"; includeDeleted: boolean }): Promise<Array<{ slug: string }>>;
  getChunks(slug: string, o: { sourceId: string }): Promise<ChunkRow[]>;
  upsertChunks(slug: string, chunks: object[], o: { sourceId: string }): Promise<void>;
  setPageEmbeddingSignature(slug: string, o: { sourceId: string; signature: string }): Promise<void>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
  transaction<T>(fn: (tx: ReembedEngine) => Promise<T>): Promise<T>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export interface ReembedPage {
  sourceId: string;
  slug: string;
  chunks: number;
  mismatched: number;
}

/** Pages listed in a report; the counts cover all of them. */
export const REPORT_PAGE_LIMIT = 50;

export interface ReembedReport {
  target: string;
  brainModel: string | null;
  apply: boolean;
  /** Chunk count per label found on mismatched chunks. */
  byModel: Record<string, number>;
  /** The first REPORT_PAGE_LIMIT pages that need work. */
  pages: ReembedPage[];
  pagesMismatched: number;
  chunksMismatched: number;
  /** Already labelled with the target and on the current signature (whole-brain runs). */
  pagesCurrent: number;
  pagesReembedded: number;
  chunksReembedded: number;
  /** Changed by another writer between the embed call and the write; left to that writer. */
  pagesChanged: number;
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

async function pageMeta(engine: ReembedEngine, slug: string, sourceId: string): Promise<{ signature: string | null; images: Set<number> }> {
  const rows = await engine.executeRaw<{ sig: string | null; idx: number | null; modality: string | null }>(
    `SELECT p.embedding_signature AS sig, cc.chunk_index AS idx, cc.modality AS modality
       FROM pages p LEFT JOIN content_chunks cc ON cc.page_id = p.id
      WHERE p.slug = $1 AND p.source_id = $2`,
    [slug, sourceId],
  );
  const images = new Set<number>();
  for (const r of rows) if (r.modality === "image" && r.idx !== null) images.add(Number(r.idx));
  return { signature: rows[0]?.sig ?? null, images };
}

const sameTexts = (a: ChunkRow[], b: ChunkRow[]): boolean =>
  a.length === b.length && a.every((c, i) => c.chunk_index === b[i]!.chunk_index && c.chunk_text === b[i]!.chunk_text);

/** The pure core: plan, and with `apply` re-embed, against an engine. */
export async function reembedModelMismatch(d: ReembedDeps, apply: boolean): Promise<ReembedReport> {
  const log = d.log ?? (() => {});
  const target = normalizeEmbeddingModel(d.target)!;
  const brainModel = normalizeEmbeddingModel(await d.engine.getConfig("embedding_model"));
  const wholeBrain = brainModel !== null && brainModel !== target;
  const signature = d.signature();
  const report: ReembedReport = {
    target, brainModel, apply, byModel: {}, pages: [], pagesMismatched: 0, chunksMismatched: 0, pagesCurrent: 0,
    pagesReembedded: 0, chunksReembedded: 0, pagesChanged: 0, errors: [], brainModelUpdated: false,
  };
  if (wholeBrain) log(`brain record names ${brainModel}, configured is ${target}: every page not yet on ${target} is re-embedded`);

  for (const sourceId of d.sourceIds) {
    for (let offset = 0; ; offset += PAGE) {
      const pages = await d.engine.listPages({ sourceId, limit: PAGE, offset, sort: "slug", includeDeleted: true });
      for (const { slug } of pages) {
        const chunks = await d.engine.getChunks(slug, { sourceId });
        if (chunks.length === 0) continue;
        const meta = await pageMeta(d.engine, slug, sourceId);
        const text = chunks.filter((c) => !meta.images.has(c.chunk_index));
        if (text.length === 0) continue;
        const mislabelled = text.filter((c) => normalizeEmbeddingModel(c.model) !== target);
        const current = mislabelled.length === 0 && meta.signature === signature;
        if (mislabelled.length === 0 && (!wholeBrain || current)) {
          if (wholeBrain || current) report.pagesCurrent++;
          continue;
        }
        const bad = mislabelled.length > 0 ? mislabelled : text;
        for (const c of bad) {
          const m = normalizeEmbeddingModel(c.model) ?? "(none)";
          report.byModel[m] = (report.byModel[m] ?? 0) + 1;
        }
        report.chunksMismatched += bad.length;
        report.pagesMismatched++;
        if (report.pages.length < REPORT_PAGE_LIMIT) report.pages.push({ sourceId, slug, chunks: chunks.length, mismatched: bad.length });
        if (!apply) continue;
        try {
          const vectors = await d.embed(text.map((c) => c.chunk_text));
          const byIndex = new Map(text.map((c, i) => [c.chunk_index, vectors[i]]));
          const written = await d.engine.transaction(async (tx) => {
            if (!sameTexts(await tx.getChunks(slug, { sourceId }), chunks)) return false;
            await tx.upsertChunks(
              slug,
              chunks.map((c) => {
                const image = meta.images.has(c.chunk_index);
                return {
                  chunk_index: c.chunk_index,
                  chunk_text: c.chunk_text,
                  chunk_source: c.chunk_source,
                  ...(image ? { model: c.model ?? undefined } : { embedding: byIndex.get(c.chunk_index), model: target }),
                  modality: image ? "image" : "text",
                  token_count: c.token_count ?? Math.ceil(c.chunk_text.length / 4),
                  language: c.language ?? null,
                  symbol_name: c.symbol_name ?? null,
                  symbol_type: c.symbol_type ?? null,
                  start_line: c.start_line ?? null,
                  end_line: c.end_line ?? null,
                  parent_symbol_path: c.parent_symbol_path ?? null,
                  doc_comment: c.doc_comment ?? null,
                  symbol_name_qualified: c.symbol_name_qualified ?? null,
                };
              }),
              { sourceId },
            );
            await tx.setPageEmbeddingSignature(slug, { sourceId, signature });
            return true;
          });
          if (!written) {
            report.pagesChanged++;
            log(`skipped ${sourceId}/${slug}: changed while re-embedding (its new write stands)`);
            continue;
          }
          report.pagesReembedded++;
          report.chunksReembedded += text.length;
          log(`re-embedded ${sourceId}/${slug} (${text.length} chunks)`);
        } catch (e) {
          report.errors.push({ sourceId, slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (pages.length < PAGE) break;
    }
  }

  if (apply && wholeBrain && report.errors.length === 0 && report.pagesChanged === 0) {
    await d.engine.setConfig("embedding_model", target);
    if (d.targetDims) await d.engine.setConfig("embedding_dimensions", String(d.targetDims));
    report.brainModelUpdated = true;
    log(`brain record set to ${target}`);
  }
  return report;
}

interface Booted {
  engine: ReembedEngine;
  target: string;
  targetDims: number | null;
}

/**
 * Boot the local brain in realign mode (the boot guard logs a mismatch but
 * neither adopts nor refuses, so the command decides). Refuses where the
 * command cannot do its job: a remote-mode client (run it where the brain
 * engine lives), no configured model, or a dimension mismatch (the vector
 * column width cannot change by re-embedding or relabelling).
 */
async function bootForRepair(): Promise<Booted> {
  if (brainMode() === "remote") {
    throw new Error("SLAUDE_BRAIN_MODE=remote: run this where the brain engine runs (the brain server)");
  }
  allowEmbeddingRealign(true);
  const engine = (await getBrain()) as unknown as ReembedEngine;
  const target = configuredEmbeddingModel();
  if (!target) throw new Error("no embedding model configured in this process: set EMBEDDING_PROVIDER / EMBEDDING_MODEL as on the gateway");
  const targetDims = Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) || null;
  const storedDims = Number(await engine.getConfig("embedding_dimensions")) || null;
  if (storedDims && targetDims && storedDims !== targetDims) {
    throw new Error(`brain embedding_dimensions is ${storedDims}, configured is ${targetDims}: neither re-embedding nor relabelling can change the vector column width`);
  }
  return { engine, target, targetDims };
}

export async function runReembedCommand(o: { apply: boolean; sourceIds?: string[]; log?: (m: string) => void }): Promise<ReembedReport> {
  const { engine, target, targetDims } = await bootForRepair();
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

export interface AdoptReport {
  apply: boolean;
  from: string | null;
  to: string;
  changed: boolean;
}

/** `--adopt`: record the configured model as the brain's, without touching a vector. */
export async function runAdoptCommand(o: { apply: boolean }): Promise<AdoptReport> {
  const { engine, target, targetDims } = await bootForRepair();
  const from = normalizeEmbeddingModel(await engine.getConfig("embedding_model"));
  const changed = from !== target;
  if (o.apply && changed) {
    await engine.setConfig("embedding_model", target);
    if (targetDims) await engine.setConfig("embedding_dimensions", String(targetDims));
  }
  return { apply: o.apply, from, to: target, changed };
}

export function formatAdoptReport(r: AdoptReport): string {
  if (!r.changed) return `brain record already names ${r.to}: nothing to adopt`;
  if (!r.apply) return `brain record: ${r.from ?? "(none)"}; configured: ${r.to}\ndry run: nothing changed. Re-run with --apply to record ${r.to} (no vector is touched).`;
  return `brain record adopted: ${r.from ?? "(none)"} -> ${r.to}`;
}

export function formatReembedReport(r: ReembedReport): string {
  const lines = [
    `configured model: ${r.target}; brain record: ${r.brainModel ?? "(none)"}`,
    `pages to re-embed: ${r.pagesMismatched} (${r.chunksMismatched} chunk(s)); already current: ${r.pagesCurrent}`,
  ];
  for (const [m, n] of Object.entries(r.byModel)) lines.push(`  label ${m}: ${n}`);
  for (const p of r.pages) lines.push(`  ${p.sourceId}/${p.slug}: ${p.mismatched}/${p.chunks}`);
  if (r.pagesMismatched > r.pages.length) lines.push(`  ... ${r.pagesMismatched - r.pages.length} more`);
  if (!r.apply) {
    lines.push("dry run: nothing changed. Re-run with --apply to re-embed these pages with the configured model.");
  } else {
    lines.push(`re-embedded ${r.chunksReembedded} chunk(s) on ${r.pagesReembedded} page(s)`);
    if (r.pagesChanged) lines.push(`skipped ${r.pagesChanged} page(s) changed during the run; run again to cover them`);
    if (r.brainModelUpdated) lines.push(`brain record set to ${r.target}`);
    for (const e of r.errors) lines.push(`  FAILED ${e.sourceId}/${e.slug}: ${e.error}`);
  }
  return lines.join("\n");
}
