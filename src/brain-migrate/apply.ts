// src/brain-migrate/apply.ts
import type { BundlePage } from "./bundle";
import type { MigrateEngine } from "./engine-types";

export type OnConflict = "skip" | "overwrite" | "fail";
export type PageOutcome = "written" | "skipped" | "overwritten" | "failed";
export interface ApplyPage { page: BundlePage; target: string; linkTargets: BundlePage["links"] }
export interface ApplyResult { outcome: PageOutcome; linksWritten: number; linksDropped: number; noEmbedding: number }

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
  o: { onConflict: OnConflict; dryRun: boolean; ensureSource: (id: string) => Promise<void> },
): Promise<ApplyResult> {
  const { page: p, target } = a;
  const so = { sourceId: target };
  const none = (outcome: PageOutcome): ApplyResult => ({ outcome, linksWritten: 0, linksDropped: 0, noEmbedding: 0 });
  const noEmbedding = p.chunks.filter((c) => c.embedding === null).length;
  try {
    const exists = (await engine.getPage(p.slug, { ...so, includeDeleted: true })) !== null;
    if (exists && o.onConflict === "skip") return none("skipped");
    if (exists && o.onConflict === "fail") return none("failed");
    if (o.dryRun) return { ...none(exists ? "overwritten" : "written"), noEmbedding };
    await o.ensureSource(target);
    await engine.transaction(async (tx) => {
      if (exists) await tx.db.query("DELETE FROM pages WHERE slug = $1 AND source_id = $2", [p.slug, target]);
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
    let linksWritten = 0, linksDropped = 0;
    for (const l of a.linkTargets) {
      if ((await engine.getPage(l.toSlug, { sourceId: l.toSource })) === null) { linksDropped++; continue; }
      await engine.addLink(p.slug, l.toSlug, l.context, l.type, "manual", undefined, undefined, { fromSourceId: target, toSourceId: l.toSource });
      linksWritten++;
    }
    return { outcome: exists ? "overwritten" : "written", linksWritten, linksDropped, noEmbedding };
  } catch {
    return none("failed");
  }
}
