// tests/brain-migrate/apply.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIMS, vec } from "./seed";

const home = mkdtempSync(join(tmpdir(), "bm-apply-"));
process.env.SLAUDE_BRAIN_HOME = home;
import { closeBrain, ensureSource, getBrain } from "../../src/knowledge/brain";
import { applyLinks, applyPage } from "../../src/brain-migrate/apply";
import type { MigrateEngine } from "../../src/brain-migrate/engine-types";
import type { BundlePage } from "../../src/brain-migrate/bundle";

let engine: MigrateEngine;
beforeAll(async () => { engine = (await getBrain()) as unknown as MigrateEngine; }, 60_000);
afterAll(async () => { await closeBrain(); rmSync(home, { recursive: true, force: true }); });

const mk = (slug: string, truth: string, over: Partial<BundlePage> = {}): BundlePage => ({
  source: "agent-default", slug, type: "note", title: slug, compiledTruth: truth, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: truth, source: "compiled_truth", embedding: vec(1), model: "test-embed", tokens: 3 }],
  tags: ["a"], timelineEntries: [{ date: "2024-03-05", source: "s", summary: "sum", detail: "" }],
  raw: [{ source: "r", data: { x: 1 } }], links: [], ...over,
});
const opts = (onConflict: "skip" | "overwrite" | "fail", dryRun = false) => ({ onConflict, dryRun, ensureSource });
const run = (p: BundlePage, target: string, o = opts("skip")) => applyPage(engine, { page: p, target, linkTargets: p.links }, o);

describe("applyPage", () => {
  test("writes page, chunks with embeddings, tags, original timeline date, raw data", async () => {
    const r = await run(mk("p1", "first body"), "agent-uone");
    expect(r.outcome).toBe("written");
    const so = { sourceId: "agent-uone" };
    expect((await engine.getPage("p1", so))!.slug).toBe("p1");
    const ch = await engine.getChunksWithEmbeddings("p1", so);
    expect(ch[0]!.embedding!.length).toBe(TEST_DIMS);
    expect(Array.from(ch[0]!.embedding!)[3]).toBeCloseTo(vec(1)[3]!, 5);
    expect(await engine.getTags("p1", so)).toEqual(["a"]);
    expect(new Date((await engine.getTimeline("p1", so))[0]!.date).toISOString().slice(0, 10)).toBe("2024-03-05");
    expect((await engine.getRawData("p1", undefined, so))[0]!.data).toEqual({ x: 1 });
  });
  test("skip leaves an existing page alone; overwrite replaces; fail reports", async () => {
    await run(mk("p2", "old body"), "agent-uone");
    expect((await run(mk("p2", "new body"), "agent-uone")).outcome).toBe("skipped");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("old body");
    expect((await run(mk("p2", "new body"), "agent-uone", opts("overwrite"))).outcome).toBe("overwritten");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("new body");
    expect((await run(mk("p2", "third"), "agent-uone", opts("fail"))).outcome).toBe("failed");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("new body");
  });
  test("overwrite replaces chunks, tags and timeline instead of appending", async () => {
    await run(mk("p3", "v1", { tags: ["x", "y"] }), "agent-uone");
    await run(mk("p3", "v2", { tags: ["z"] }), "agent-uone", opts("overwrite"));
    const so = { sourceId: "agent-uone" };
    expect(await engine.getTags("p3", so)).toEqual(["z"]);
    expect((await engine.getTimeline("p3", so)).length).toBe(1);
    expect((await engine.getChunksWithEmbeddings("p3", so)).length).toBe(1);
  });
  test("dryRun writes nothing but reports the outcome", async () => {
    expect((await run(mk("p4", "dry"), "agent-uone", opts("skip", true))).outcome).toBe("written");
    expect(await engine.getPage("p4", { sourceId: "agent-uone" })).toBeNull();
  });
  const rowsFor = async (slug: string) => {
    const q = async (t: string) => (await engine.db.query(`SELECT count(*)::int AS c FROM ${t} WHERE page_id IN (SELECT id FROM pages WHERE slug = $1)`, [slug])).rows[0]!.c as number;
    const pages = (await engine.db.query("SELECT count(*)::int AS c FROM pages WHERE slug = $1", [slug])).rows[0]!.c as number;
    return { pages, chunks: await q("content_chunks"), tags: await q("tags"), timeline: await q("timeline_entries"), raw: await q("raw_data") };
  };
  test("a failure mid-page (bad date, after chunks and tags) leaves no trace in any table", async () => {
    const bad = mk("p5", "boom", { timelineEntries: [{ date: "not-a-date", source: "s", summary: "x", detail: "" }] });
    expect((await run(bad, "agent-uone")).outcome).toBe("failed");
    expect(await engine.getPage("p5", { sourceId: "agent-uone" })).toBeNull();
    expect(await rowsFor("p5")).toEqual({ pages: 0, chunks: 0, tags: 0, timeline: 0, raw: 0 });
  });
  test("a failure in the last step (wrong-length embedding) also rolls back page, tags and timeline", async () => {
    const bad = mk("p5b", "boom", { chunks: [{ index: 0, text: "x", source: "compiled_truth", embedding: vec(1).slice(0, 10), model: "m", tokens: 1 }] });
    expect((await run(bad, "agent-uone")).outcome).toBe("failed");
    expect(await rowsFor("p5b")).toEqual({ pages: 0, chunks: 0, tags: 0, timeline: 0, raw: 0 });
  });
  test("a failed overwrite keeps the old page intact (the DELETE rolls back too)", async () => {
    await run(mk("p5c", "keep me", { tags: ["k1", "k2"] }), "agent-uone");
    const bad = mk("p5c", "lost", { timelineEntries: [{ date: "not-a-date", source: "s", summary: "x", detail: "" }] });
    expect((await run(bad, "agent-uone", opts("overwrite"))).outcome).toBe("failed");
    const so = { sourceId: "agent-uone" };
    expect((await engine.getPage("p5c", so) as any).compiled_truth).toBe("keep me");
    expect((await engine.getTags("p5c", so)).sort()).toEqual(["k1", "k2"]);
    expect(await rowsFor("p5c")).toEqual({ pages: 1, chunks: 1, tags: 2, timeline: 1, raw: 1 });
  });
  test("overwrite cascades every child table: raw data and links of the old page do not survive", async () => {
    await run(mk("p5d", "target"), "agent-uone");
    await run(mk("p5e", "v1", { links: [{ toSource: "agent-uone", toSlug: "p5d", type: "references", context: "c" }] }), "agent-uone");
    await run(mk("p5e", "v2", { raw: [], links: [] }), "agent-uone", opts("overwrite"));
    expect(await rowsFor("p5e")).toEqual({ pages: 1, chunks: 1, tags: 1, timeline: 1, raw: 0 });
    const l = await engine.db.query("SELECT count(*)::int AS c FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE slug = 'p5e')");
    expect(l.rows[0]!.c).toBe(0);
  });
  test("a page without embeddings is written and counted", async () => {
    const p = mk("p6", "plain", { chunks: [{ index: 0, text: "plain", source: "compiled_truth", embedding: null, model: null, tokens: null }] });
    const r = await run(p, "agent-uone");
    expect(r.outcome).toBe("written");
    expect(r.noEmbedding).toBe(1);
  });
  test("two bundle sources mapped to one target: second same slug follows onConflict", async () => {
    await run(mk("dup", "from legacy", { source: "agent" }), "agent-utwo");
    expect((await run(mk("dup", "from default"), "agent-utwo")).outcome).toBe("skipped");
  });
  test("a link whose target page is absent is dropped and counted; a present one is written", async () => {
    await run(mk("ltarget", "target"), "agent-uone");
    const src = mk("lsrc", "source", { links: [
      { toSource: "agent-uone", toSlug: "ltarget", type: "references", context: "c" },
      { toSource: "agent-uone", toSlug: "missing", type: "references", context: "c" },
    ] });
    const r = await run(src, "agent-uone");
    expect(r.linksWritten).toBe(1);
    expect(r.linksDropped).toBe(1);
  });
  test("deferLinks writes the page but no links; applyLinks then writes them once the target exists", async () => {
    const src = mk("dsrc", "source", { links: [{ toSource: "agent-uone", toSlug: "dtarget", type: "references", context: "c" }] });
    const r = await applyPage(engine, { page: src, target: "agent-uone", linkTargets: src.links }, { ...opts("skip"), deferLinks: true });
    expect(r).toMatchObject({ outcome: "written", linksWritten: 0, linksDropped: 0, linksFailed: 0 });
    await run(mk("dtarget", "target"), "agent-uone");
    expect(await applyLinks(engine, "dsrc", "agent-uone", src.links)).toEqual({ linksWritten: 1, linksDropped: 0, linksFailed: 0 });
  });
  test("overwrite keeps links from OTHER pages that point at the overwritten page", async () => {
    await run(mk("in-a", "a1", { tags: ["t1", "t2"], chunks: [
      { index: 0, text: "a", source: "compiled_truth", embedding: vec(1), model: "m", tokens: 1 },
      { index: 1, text: "b", source: "compiled_truth", embedding: vec(2), model: "m", tokens: 1 },
    ] }), "agent-uone");
    await run(mk("in-b", "b", { links: [{ toSource: "agent-uone", toSlug: "in-a", type: "references", context: "c" }] }), "agent-uone");
    const incoming = async () => (await engine.db.query("SELECT count(*)::int AS c FROM links WHERE to_page_id IN (SELECT id FROM pages WHERE slug = 'in-a') AND from_page_id IN (SELECT id FROM pages WHERE slug = 'in-b')")).rows[0]!.c;
    expect(await incoming()).toBe(1);
    await run(mk("in-a", "a2", { tags: ["t3"], raw: [], timelineEntries: [] }), "agent-uone", opts("overwrite"));
    expect(await incoming()).toBe(1);
    expect(await rowsFor("in-a")).toEqual({ pages: 1, chunks: 1, tags: 1, timeline: 0, raw: 0 });
    expect(await engine.getTags("in-a", { sourceId: "agent-uone" })).toEqual(["t3"]);
  });
  test("a link that fails to write does not fail the page; others still land", async () => {
    await run(mk("lt1", "t"), "agent-uone");
    await run(mk("lt2", "t"), "agent-uone");
    const flaky = new Proxy(engine, { get(t, k) {
      if (k === "addLink") return async (_f: string, to: string, ...rest: unknown[]) => { if (to === "lt1") throw new Error("boom"); return (t.addLink as any)(_f, to, ...rest); };
      const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v;
    } }) as MigrateEngine;
    const src = mk("lsrc2", "s", { links: [
      { toSource: "agent-uone", toSlug: "lt1", type: "references", context: "c" },
      { toSource: "agent-uone", toSlug: "lt2", type: "references", context: "c" },
    ] });
    const r = await applyPage(flaky, { page: src, target: "agent-uone", linkTargets: src.links }, opts("skip"));
    expect(r).toMatchObject({ outcome: "written", linksWritten: 1, linksFailed: 1, linksDropped: 0 });
    expect(await engine.getPage("lsrc2", { sourceId: "agent-uone" })).not.toBeNull();
  });
  test("a skipped page still gets its links; fail-policy and dry-run pages get none", async () => {
    const link = { toSource: "agent-uone", toSlug: "sk-target", type: "references", context: "c" };
    await run(mk("sk-target", "t"), "agent-uone");
    await run(mk("sk-src", "s"), "agent-uone"); // page exists, link was never written
    const linkCount = async (slug: string) => (await engine.db.query("SELECT count(*)::int AS c FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE slug = $1)", [slug])).rows[0]!.c as number;
    const withLink = mk("sk-src", "s", { links: [link] });
    const dry = await run(withLink, "agent-uone", opts("skip", true));
    expect(dry).toMatchObject({ outcome: "skipped", linksWritten: 0 });
    const fail = await run(withLink, "agent-uone", opts("fail"));
    expect(fail).toMatchObject({ outcome: "failed", linksWritten: 0 });
    expect(await linkCount("sk-src")).toBe(0);
    const r = await run(withLink, "agent-uone", opts("skip"));
    expect(r).toMatchObject({ outcome: "skipped", linksWritten: 1, linksDropped: 0, linksFailed: 0 });
    expect(await linkCount("sk-src")).toBe(1);
    expect(await run(withLink, "agent-uone", opts("skip"))).toMatchObject({ outcome: "skipped", linksWritten: 1 });
    expect(await linkCount("sk-src")).toBe(1); // idempotent
  });
  test("overwrite needs only executeRaw (Postgres engines have no .db)", async () => {
    await run(mk("nodb", "v1"), "agent-uone");
    const noDb = new Proxy(engine, { get(t, k) {
      if (k === "db") return undefined;
      if (k === "transaction") return (fn: any) => (t as any).transaction((tx: any) => fn(new Proxy(tx, { get(x, kk) { if (kk === "db") return undefined; const v = x[kk]; return typeof v === "function" ? v.bind(x) : v; } })));
      const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v;
    } }) as MigrateEngine;
    const r = await applyPage(noDb, { page: mk("nodb", "v2"), target: "agent-uone", linkTargets: [] }, opts("overwrite"));
    expect(r.outcome).toBe("overwritten");
    expect((await engine.getPage("nodb", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("v2");
  });
  test("failures carry a reason: exists (fail policy) vs tx (with errorName only)", async () => {
    await run(mk("rs1", "x"), "agent-uone");
    expect(await run(mk("rs1", "y"), "agent-uone", opts("fail"))).toMatchObject({ outcome: "failed", reason: "exists", linksFailed: 0 });
    const bad = mk("rs2", "boom", { timelineEntries: [{ date: "not-a-date", source: "s", summary: "x", detail: "" }] });
    const r = await run(bad, "agent-uone");
    expect(r).toMatchObject({ outcome: "failed", reason: "tx" });
    expect(typeof r.errorName).toBe("string");
    expect(JSON.stringify(r)).not.toContain("not-a-date");
  });
});
