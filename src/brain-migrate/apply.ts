// src/brain-migrate/apply.ts
import type { BundlePage } from "./bundle";
import type { MigrateEngine } from "./engine-types";

export type OnConflict = "skip" | "overwrite" | "fail";
export type PageOutcome = "written" | "skipped" | "overwritten" | "failed";
export interface ApplyPage { page: BundlePage; target: string; linkTargets: BundlePage["links"] }
export interface ApplyResult {
  outcome: PageOutcome; linksWritten: number; linksDropped: number; linksFailed: number; noEmbedding: number;
  /** Only for outcome "failed": "exists" = fail-policy conflict, "tx" = ensureSource/transaction failure, "error" = anything else. */
  reason?: "exists" | "tx" | "error";
  /** Class name of the thrown error only; never its message, which can embed values. */
  errorName?: string;
}

/** Writes a page's links; a target that is not in the brain is dropped and counted, a failing write is counted. */
export async function applyLinks(
  engine: MigrateEngine, slug: string, target: string, linkTargets: BundlePage["links"],
): Promise<{ linksWritten: number; linksDropped: number; linksFailed: number }> {
  let linksWritten = 0, linksDropped = 0, linksFailed = 0;
  for (const l of linkTargets) {
    try {
      if ((await engine.getPage(l.toSlug, { sourceId: l.toSource })) === null) { linksDropped++; continue; }
      await engine.addLink(slug, l.toSlug, l.context, l.type, "manual", undefined, undefined, { fromSourceId: target, toSourceId: l.toSource });
      linksWritten++;
    } catch { linksFailed++; }
  }
  return { linksWritten, linksDropped, linksFailed };
}

/**
 * Writes one page, whole or not at all. The whole write (page, chunks with the
 * carried embeddings, tags, timeline with its original dates, raw data) runs in
 * one engine transaction, so a failure leaves nothing of the page behind.
 * Links run after, in their own pass: a link needs both pages to exist, and a
 * target that is not in the brain is dropped and counted, never dangling.
 */
export async function applyPage(
  engine: MigrateEngine,
  a: ApplyPage,
  o: { onConflict: OnConflict; dryRun: boolean; ensureSource: (id: string) => Promise<void>; deferLinks?: boolean },
): Promise<ApplyResult> {
  const { page: p, target } = a;
  const so = { sourceId: target };
  const none = (outcome: PageOutcome): ApplyResult => ({ outcome, linksWritten: 0, linksDropped: 0, linksFailed: 0, noEmbedding: 0 });
  let stage: "error" | "tx" = "error";
  const noEmbedding = p.chunks.filter((c) => c.embedding === null).length;
  try {
    const exists = (await engine.getPage(p.slug, { ...so, includeDeleted: true })) !== null;
    if (exists && o.onConflict === "skip") {
      // A skipped page still gets its links: a re-run heals links dropped earlier (target in a later
      // batch, or lost to a crash before the links pass). addLink is idempotent.
      if (o.dryRun || o.deferLinks) return none("skipped");
      return { ...none("skipped"), ...(await applyLinks(engine, p.slug, target, a.linkTargets)) };
    }
    if (exists && o.onConflict === "fail") return { ...none("failed"), reason: "exists" };
    if (o.dryRun) return { ...none(exists ? "overwritten" : "written"), noEmbedding };
    stage = "tx";
    await o.ensureSource(target);
    await engine.transaction(async (tx) => {
      if (exists) {
        // Keep the page row: deleting it would cascade away links from OTHER pages that point here.
        const me = "(SELECT id FROM pages WHERE slug = $1 AND source_id = $2)";
        const args = [p.slug, target];
        for (const t of ["content_chunks", "tags", "timeline_entries", "raw_data"]) await tx.executeRaw(`DELETE FROM ${t} WHERE page_id = ${me}`, args);
        await tx.executeRaw(`DELETE FROM links WHERE from_page_id = ${me}`, args);
      }
      await tx.putPage(p.slug, {
        type: p.type, title: p.title, compiled_truth: p.compiledTruth, timeline: p.timeline,
        frontmatter: p.frontmatter, ...(p.contentHash ? { content_hash: p.contentHash } : {}),
      }, so);
      if (p.chunks.length) {
        await tx.upsertChunks(p.slug, p.chunks.map((c) => ({
          chunk_index: c.index, chunk_text: c.text, chunk_source: c.source,
          ...(c.embedding ? { embedding: Float32Array.from(c.embedding) } : {}),
          ...(c.model ? { model: c.model } : {}), ...(c.tokens !== null ? { token_count: c.tokens } : {}),
        })), so);
      }
      for (const t of p.tags) await tx.addTag(p.slug, t, so);
      for (const e of p.timelineEntries) await tx.addTimelineEntry(p.slug, { date: e.date, source: e.source, summary: e.summary, detail: e.detail }, { ...so, skipExistenceCheck: true });
      for (const r of p.raw) await tx.putRawData(p.slug, r.source, r.data, so);
    });
    stage = "error";
    // A caller applying a batch defers links until every page of the batch exists
    // (applyLinks): a link to a page later in the same batch would otherwise be dropped.
    const l = o.deferLinks ? { linksWritten: 0, linksDropped: 0, linksFailed: 0 } : await applyLinks(engine, p.slug, target, a.linkTargets);
    return { outcome: exists ? "overwritten" : "written", ...l, noEmbedding };
  } catch (e) {
    return { ...none("failed"), reason: stage, errorName: e instanceof Error ? e.constructor.name : typeof e };
  }
}
