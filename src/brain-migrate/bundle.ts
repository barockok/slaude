import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const BUNDLE_VERSION = 1;

export interface BundleChunk { index: number; text: string; source: "compiled_truth" | "timeline" | "fenced_code"; embedding: number[] | null; model: string | null; tokens: number | null }
export interface BundlePage {
  source: string; slug: string; type: string; title: string; compiledTruth: string; timeline: string;
  frontmatter: Record<string, unknown>; contentHash: string | null;
  chunks: BundleChunk[]; tags: string[];
  timelineEntries: Array<{ date: string; source: string; summary: string; detail: string }>;
  raw: Array<{ source: string; data: Record<string, unknown> }>;
  links: Array<{ toSource: string; toSlug: string; type: string; context: string }>;
}
export interface BundleEngineInfo { schemaVersion: number | null; embeddingModel: string | null; embeddingDimensions: number | null }
export interface BundleManifest {
  version: number; createdAt: string; engine: BundleEngineInfo;
  sources: Array<{ id: string; pages: number; chunks: number; embedded: number }>;
  files: { "pages.jsonl": string }; excluded: string[];
}

export class BundleWriter {
  private out: WriteStream;
  private hash = createHash("sha256");
  private inv = new Map<string, { pages: number; chunks: number; embedded: number }>();

  private err: Error | null = null;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    // A manifest left by an earlier export must not outlive the pages.jsonl we are about to rewrite.
    rmSync(join(dir, "manifest.json"), { force: true });
    this.out = createWriteStream(join(dir, "pages.jsonl"), { flags: "w" });
    this.out.on("error", (e) => { this.err = e; });
  }

  async writePage(p: BundlePage): Promise<void> {
    if (this.err) throw this.err;
    const line = JSON.stringify(p) + "\n";
    this.hash.update(line);
    const s = this.inv.get(p.source) ?? { pages: 0, chunks: 0, embedded: 0 };
    s.pages++; s.chunks += p.chunks.length; s.embedded += p.chunks.filter((c) => c.embedding !== null).length;
    this.inv.set(p.source, s);
    if (!this.out.write(line)) {
      await new Promise<void>((res, rej) => {
        const onErr = (e: Error) => { this.out.off("drain", onDrain); rej(e); };
        const onDrain = () => { this.out.off("error", onErr); res(); };
        this.out.once("drain", onDrain);
        this.out.once("error", onErr);
      });
    }
  }

  /** Closes pages.jsonl, then writes the manifest LAST (no manifest = interrupted export). */
  async finish(meta: { engine: BundleEngineInfo; excluded: string[] }): Promise<BundleManifest> {
    if (!this.err && !this.out.destroyed) {
      await new Promise<void>((res) => {
        this.out.once("error", () => res());
        this.out.end(() => res());
      });
    }
    // destroy(err) reports the error on a later tick; let it land so the real cause is thrown.
    if (!this.err && this.out.destroyed && !this.out.closed) await new Promise<void>((r) => this.out.once("close", () => r()));
    if (this.err) throw this.err;
    if (!this.out.writableFinished) throw new Error("pages.jsonl stream was closed before finish");
    const manifest: BundleManifest = {
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      engine: meta.engine,
      sources: [...this.inv.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => ({ id, ...s })),
      files: { "pages.jsonl": this.hash.digest("hex") },
      excluded: meta.excluded,
    };
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  }
}

export function readManifest(dir: string): BundleManifest {
  const f = join(dir, "manifest.json");
  if (!existsSync(f)) throw new Error("bundle has no manifest.json (interrupted export?)");
  const m = JSON.parse(readFileSync(f, "utf8")) as Partial<BundleManifest>;
  if (m.version !== BUNDLE_VERSION) throw new Error(`unsupported bundle version ${String(m.version)} (want ${BUNDLE_VERSION})`);
  if (!m.files || typeof m.files["pages.jsonl"] !== "string") throw new Error("manifest has no files checksum");
  if (!m.engine || !Array.isArray(m.sources)) throw new Error("manifest is missing engine or sources");
  return m as BundleManifest;
}

export async function verifyBundle(dir: string): Promise<BundleManifest> {
  const m = readManifest(dir);
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => {
    createReadStream(join(dir, "pages.jsonl")).on("data", (c) => h.update(c)).on("end", () => res()).on("error", rej);
  });
  if (h.digest("hex") !== m.files["pages.jsonl"]) throw new Error("pages.jsonl checksum does not match the manifest");
  return m;
}

export async function* readPages(dir: string): AsyncGenerator<BundlePage> {
  const rl = createInterface({ input: createReadStream(join(dir, "pages.jsonl"), { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line) as BundlePage;
}

export async function* batchPages(pages: AsyncIterable<BundlePage>, maxPages = 100, maxBytes = 1_000_000): AsyncGenerator<BundlePage[]> {
  let batch: BundlePage[] = [];
  let bytes = 0;
  for await (const p of pages) {
    const size = Buffer.byteLength(JSON.stringify(p));
    if (batch.length > 0 && (batch.length >= maxPages || bytes + size > maxBytes)) {
      yield batch; batch = []; bytes = 0;
    }
    batch.push(p); bytes += size;
  }
  if (batch.length) yield batch;
}
