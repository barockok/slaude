import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION, BundleWriter, batchPages, readManifest, readPages, verifyBundle, type BundlePage } from "../../src/brain-migrate/bundle";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "bundle-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const page = (slug: string, source = "agent-default", withEmb = true): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: `truth ${slug}`, timeline: "",
  frontmatter: { k: 1 }, contentHash: "h-" + slug,
  chunks: [{ index: 0, text: `truth ${slug}`, source: "compiled_truth", embedding: withEmb ? [0.5, -0.25, 0] : null, model: withEmb ? "m" : null, tokens: 3 }],
  tags: ["t1"], timelineEntries: [{ date: "2025-01-02", source: "s", summary: "did", detail: "" }],
  raw: [], links: [],
});
const meta = { engine: { schemaVersion: 1, embeddingModel: "m", embeddingDimensions: 3 }, excluded: ["kb-*"] };

describe("bundle", () => {
  test("round trip preserves pages and builds the inventory", async () => {
    const d = tmp();
    const w = new BundleWriter(d);
    await w.writePage(page("a")); await w.writePage(page("b", "shared", false));
    const m = await w.finish(meta);
    expect(m.version).toBe(BUNDLE_VERSION);
    expect(m.sources).toEqual([
      { id: "agent-default", pages: 1, chunks: 1, embedded: 1 },
      { id: "shared", pages: 1, chunks: 1, embedded: 0 },
    ]);
    const back: BundlePage[] = [];
    for await (const p of readPages(d)) back.push(p);
    expect(back.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(back[0]!.chunks[0]!.embedding).toEqual([0.5, -0.25, 0]);
    expect((await verifyBundle(d)).files["pages.jsonl"]).toBe(m.files["pages.jsonl"]);
  });
  test("an empty bundle is valid", async () => {
    const d = tmp();
    const m = await new BundleWriter(d).finish(meta);
    expect(m.sources).toEqual([]);
    expect((await verifyBundle(d)).sources).toEqual([]);
  });
  test("no manifest (interrupted export) is refused", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a"));
    expect(() => readManifest(d)).toThrow(/manifest/i);
  });
  test("a flipped byte and an appended line both fail the checksum", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a")); await w.finish(meta);
    const f = join(d, "pages.jsonl");
    const orig = readFileSync(f, "utf8");
    writeFileSync(f, orig.replace("truth a", "truth X"));
    await expect(verifyBundle(d)).rejects.toThrow(/checksum/i);
    writeFileSync(f, orig); appendFileSync(f, "{}\n");
    await expect(verifyBundle(d)).rejects.toThrow(/checksum/i);
  });
  test("manifest without files or with a future version is refused", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a")); const m = await w.finish(meta);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...m, files: undefined }));
    expect(() => readManifest(d)).toThrow(/files/);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...m, version: 99 }));
    expect(() => readManifest(d)).toThrow(/version/);
  });
  test("batchPages cuts on page count and on bytes", async () => {
    async function* gen(n: number) { for (let i = 0; i < n; i++) yield page("p" + i); }
    const sizes: number[] = [];
    for await (const b of batchPages(gen(5), 2)) sizes.push(b.length);
    expect(sizes).toEqual([2, 2, 1]);
    const byBytes: number[] = [];
    for await (const b of batchPages(gen(4), 100, JSON.stringify(page("p0")).length + 10)) byBytes.push(b.length);
    expect(byBytes).toEqual([1, 1, 1, 1]);
  });
  test("a stream error mid-export rejects and leaves no manifest", async () => {
    const d = tmp();
    const w = new BundleWriter(d);
    await w.writePage(page("a"));
    (w as any).out.destroy(new Error("disk full"));
    await new Promise((r) => setTimeout(r, 10));
    await expect(w.writePage(page("b"))).rejects.toThrow(/disk full/);
    await expect(w.finish(meta)).rejects.toThrow(/disk full/);
    expect(existsSync(join(d, "manifest.json"))).toBe(false);
  });
  test("a stream error during finish rejects without a manifest", async () => {
    const d = tmp();
    const w = new BundleWriter(d);
    await w.writePage(page("a"));
    (w as any).out.destroy(new Error("disk full"));
    await expect(w.finish(meta)).rejects.toThrow(/disk full/);
    expect(existsSync(join(d, "manifest.json"))).toBe(false);
  });
  test("batchPages measures bytes, and an oversize page goes alone", async () => {
    const big = (slug: string) => ({ ...page(slug), compiledTruth: "\u00e9".repeat(1000) });
    const one = Buffer.byteLength(JSON.stringify(big("x")));
    async function* gen() { yield big("a"); yield big("b"); }
    const sizes: number[] = [];
    // 1.5 pages in bytes; UTF-16 length would be ~1.3x smaller and fit two
    for await (const b of batchPages(gen(), 100, Math.floor(one * 1.5))) sizes.push(b.length);
    expect(sizes).toEqual([1, 1]);
    const alone: number[] = [];
    for await (const b of batchPages(gen(), 100, 10)) alone.push(b.length);
    expect(alone).toEqual([1, 1]);
  });
  test("a new writer removes a stale manifest", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a")); await w.finish(meta);
    expect(existsSync(join(d, "manifest.json"))).toBe(true);
    new BundleWriter(d);
    expect(existsSync(join(d, "manifest.json"))).toBe(false);
  });
});
