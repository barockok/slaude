// src/brain-migrate/export.ts
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BundleWriter, type BundleManifest, type BundlePage } from "./bundle";
import { readEmbeddingInfo } from "./embedding-info";
import { isAgentLike } from "./remap";
import type { MigrateEngine } from "./engine-types";
import { keepingExitCode } from "../db/wasm-exit-code";

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

export interface ExportOptions { home: string; out: string; include?: string[]; exclude?: string[] }
export interface ExportResult { manifest: BundleManifest; copied: string }

const matches = (id: string, pat: string): boolean => (pat === "kb-" ? id.startsWith("kb-") : id === pat);

export function selectSources(all: string[], include: string[] | undefined, exclude: string[] | undefined): { keep: string[]; excluded: string[] } {
  const keep: string[] = [];
  const excluded: string[] = [];
  for (const id of all) {
    const dropped = include && include.length
      ? !include.some((p) => matches(id, p))
      : id.startsWith("kb-") || (exclude ?? []).some((p) => matches(id, p));
    const explicitExclude = (exclude ?? []).some((p) => matches(id, p));
    (dropped || explicitExclude ? excluded : keep).push(id);
  }
  return { keep, excluded };
}

/**
 * Agent-like sources are written most specific first: `agent-<real id>`, then
 * `agent-default`, then the legacy `agent` slice. All of them import into one
 * slice and the default skip policy keeps the FIRST copy of a slug, so the
 * current copy must come before the oldest. Other sources keep their order, and
 * the agent-like ones are placed into the slots the agent-like ids occupied.
 */
export function orderSources(keep: string[]): string[] {
  const rank = (s: string): number => (s === "agent" ? 2 : s === "agent-default" ? 1 : 0);
  const agents = keep.filter(isAgentLike).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let i = 0;
  return keep.map((s) => (isAgentLike(s) ? agents[i++]! : s));
}

function readBrainConfig(home: string): { embedding_model?: string; embedding_dimensions?: number } {
  try { return JSON.parse(readFileSync(join(home, "config.json"), "utf8")); } catch { return {}; }
}

/**
 * Reads a COPY of the brain directory through the gbrain engine. Never calls
 * slaude's getBrain() (it clears locks and runs schema writes) and never opens
 * the original, so a live brain is not locked and nothing in it changes.
 */
export async function exportBrain(o: ExportOptions): Promise<ExportResult> {
  if (!existsSync(join(o.home, "db"))) throw new Error(`brain home '${o.home}' has no db directory`);
  const copied = mkdtempSync(join(tmpdir(), "brain-export-"));
  let engine: MigrateEngine | null = null;
  try {
    // gbrain's PGLite lock lives inside the data dir; a copied live lock would make connect() wait on a foreign pid.
    cpSync(o.home, copied, { recursive: true, filter: (src) => basename(src) !== ".gbrain-lock" });
    const cfg = { engine: "pglite", database_path: join(copied, "db") };
    const { createEngine } = (await gbrainImport("engine-factory")) as { createEngine: (c: object) => Promise<MigrateEngine> };
    // keepingExitCode: PGLite's WASM runtime writes its own status into process.exitCode.
    engine = await keepingExitCode(async () => {
      const e = await createEngine(cfg);
      await e.connect(cfg);
      return e;
    });
    const ids = (await engine.db.query("SELECT id FROM sources ORDER BY id")).rows.map((r) => String(r.id));
    const { keep, excluded } = selectSources(ids, o.include, o.exclude);
    const w = new BundleWriter(o.out);
    for (const source of orderSources(keep)) {
      for (let offset = 0; ; offset += 200) {
        const batch = await engine.listPages({ sourceId: source, limit: 200, offset, sort: "slug" });
        if (batch.length === 0) break;
        for (const pg of batch) await w.writePage(await readPage(engine, source, pg));
      }
    }
    // The pgvector column width is the authoritative dimension (config.json may be absent).
    const manifest = await w.finish({
      engine: { schemaVersion: null, ...(await readEmbeddingInfo(engine, () => readBrainConfig(copied))) },
      excluded,
    });
    return { manifest, copied };
  } finally {
    const e = engine;
    if (e) await keepingExitCode(() => e.disconnect()).catch(() => {});
    rmSync(copied, { recursive: true, force: true });
  }
}

async function readPage(engine: MigrateEngine, source: string, pg: Awaited<ReturnType<MigrateEngine["listPages"]>>[number]): Promise<BundlePage> {
  const so = { sourceId: source };
  const chunks = await engine.getChunksWithEmbeddings(pg.slug, so);
  const links = (await engine.db.query(
    `SELECT l.link_type, l.context, l.link_source, l.origin_field, tp.slug AS to_slug, tp.source_id AS to_source,
            op.slug AS origin_slug, op.source_id AS origin_source
       FROM links l JOIN pages fp ON fp.id = l.from_page_id JOIN pages tp ON tp.id = l.to_page_id
       LEFT JOIN pages op ON op.id = l.origin_page_id
      WHERE fp.slug = $1 AND fp.source_id = $2 AND tp.deleted_at IS NULL`, [pg.slug, source])).rows;
  return {
    source, slug: pg.slug, type: pg.type, title: pg.title, compiledTruth: pg.compiled_truth, timeline: pg.timeline,
    frontmatter: pg.frontmatter ?? {}, contentHash: pg.content_hash ?? null,
    chunks: chunks.map((c) => ({
      index: c.chunk_index, text: c.chunk_text, source: c.chunk_source,
      embedding: c.embedding ? Array.from(c.embedding) : null, model: c.embedding ? c.model : null, tokens: c.token_count,
    })),
    tags: await engine.getTags(pg.slug, so),
    timelineEntries: (await engine.getTimeline(pg.slug, { ...so, limit: 100000 })).map((t) => ({ date: typeof t.date === "string" ? t.date.slice(0, 10) : t.date.toISOString().slice(0, 10), source: t.source, summary: t.summary, detail: t.detail })),
    raw: (await engine.getRawData(pg.slug, undefined, so)).map((r) => ({ source: r.source, data: r.data })),
    links: links.map((l) => ({ toSource: String(l.to_source), toSlug: String(l.to_slug), type: String(l.link_type), context: String(l.context),
      ...(l.link_source != null ? { linkSource: String(l.link_source) } : {}),
      ...(l.origin_slug != null && l.origin_source != null ? { originSlug: String(l.origin_slug), originSource: String(l.origin_source), ...(l.origin_field != null ? { originField: String(l.origin_field) } : {}) } : {}),
    })),
  };
}
