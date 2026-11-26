/**
 * Pack unit load test (box plan, Phase 5): how long a boxed session's home or
 * workspace extras take to flush and to hydrate cold, against the first-turn budget
 * of about 20 s (spec: docs/superpowers/specs/2026-11-24-box-design.md, "Cost estimates").
 *
 * It builds a tree shaped like a `node_modules` (many small files, some larger, a few
 * symlinks), then times, through the real code path (`flushPack`, `hydratePack`, the
 * in-process packer):
 *   1. the first flush        scan, archive, compress, upload, manifest
 *   2. a flush with no change scan only
 *   3. a flush after 10 edits scan, a small delta archive
 *   4. a cold hydrate         download every layer, apply into an empty directory
 *   5. a warm hydrate         the marker matches: nothing
 *
 *   bun scripts/load/pack-sync.ts --files 50000 --mb 500 --budget-s 20
 *
 * By default the store is a local directory (`LocalObjectStore`), which measures the
 * packer and the disk, not a network. For numbers that count against the budget, point
 * it at a real S3-compatible server: set `SLAUDE_STORAGE=s3` and the `SLAUDE_S3_*`
 * variables and pass `--store s3`. Objects go under `sessions/hm-load-<run>/` and are
 * removed at the end.
 *
 * Exit 1 when the cold hydrate exceeds the budget.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPacker, zstdAvailable } from "../../src/box/boxd/pack";
import { LocalObjectStore, S3ObjectStore, flushPack, hydratePack, latestManifest, removeUnit, s3Config, type ObjectStore, type PackManifest, type PackUnitRef } from "../../src/storage";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}
function argStr(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1]) : dflt;
}

const FILES = arg("files", 50_000);
const TOTAL_MB = arg("mb", 500);
const BUDGET_S = arg("budget-s", 20);
const STORE = argStr("store", "local");

const base = mkdtempSync(join(tmpdir(), "slaude-pack-load-"));
const store: ObjectStore = STORE === "s3" ? new S3ObjectStore(s3Config(process.env)) : new LocalObjectStore(join(base, "store"));
const unitId = `hm-load-${Date.now().toString(36)}`;

/** Text that compresses about like source code: words from a small vocabulary, salted per file. */
function content(seed: number, size: number): Buffer {
  const words = ["function", "return", "const", "module", "exports", "require", "import", "from", "export", "default", "async", "await", "=>", "{", "}", "(", ")", ";", "\n", "  "];
  const parts: string[] = [];
  let s = seed >>> 0;
  let len = 0;
  while (len < size) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = s % 7 === 0 ? `v${s.toString(36)}` : words[s % words.length]!;
    parts.push(w, " ");
    len += w.length + 1;
  }
  return Buffer.from(parts.join("").slice(0, size));
}

function build(root: string): { files: number; bytes: number; sample: string[] } {
  mkdirSync(root, { recursive: true });
  const mean = (TOTAL_MB * 1024 * 1024) / FILES;
  let bytes = 0;
  const sample: string[] = [];
  let s = 12345;
  for (let i = 0; i < FILES; i++) {
    const pkg = join(root, "node_modules", `pkg-${Math.floor(i / 2000)}`, `mod-${Math.floor(i / 100)}`);
    if (i % 100 === 0) mkdirSync(pkg, { recursive: true });
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    // Most files are small and one in fifty is large, as in a real install: the mean still comes out at total / files.
    const size = Math.max(1, Math.floor(i % 50 === 0 ? mean * 25.5 : mean * 0.5 * (0.2 + (s % 1000) / 625)));
    const p = join(pkg, `f${i}.js`);
    writeFileSync(p, content(i, size));
    bytes += size;
    if (i % 5000 === 7) sample.push(p);
    if (i % 1000 === 999) symlinkSync(`f${i}.js`, join(pkg, `link${i}`));
  }
  return { files: FILES, bytes, sample };
}

const secs = (ms: number): string => (ms / 1000).toFixed(2);
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

const packer = localPacker({ spoolDir: join(base, "spool") });
const src: PackUnitRef = { root: join(base, "src"), filter: { kind: "all", exclude: [] }, indexPath: join(base, "state-a", "index.json") };
const dst: PackUnitRef = { root: join(base, "dst"), filter: { kind: "all", exclude: [] }, indexPath: join(base, "state-b", "index.json") };

let failed = false;
try {
  const [tree, buildMs] = await timed(async () => build(src.root));
  console.log(`tree: ${tree.files} files, ${(tree.bytes / 1024 / 1024).toFixed(0)} MB, built in ${secs(buildMs)} s; store: ${STORE}; zstd: ${zstdAvailable()}`);

  const flush = () => flushPack(store, unitId, { epoch: 1, isCurrent: () => true, pack: (req) => packer.pack(src, req) });
  const [first, firstMs] = await timed(flush);
  const m1 = (await latestManifest(store, unitId))!.manifest as PackManifest;
  const [again, againMs] = await timed(flush);
  for (const p of tree.sample) writeFileSync(p, content(999, 4000));
  const [delta, deltaMs] = await timed(flush);
  const m2 = (await latestManifest(store, unitId))!.manifest as PackManifest;

  const hydrate = () => hydratePack(store, unitId, { markerPath: join(base, "state-b", "marker.json"), spoolDir: packer.spoolDir, apply: (req) => packer.apply(dst, req) });
  const [cold, coldMs] = await timed(hydrate);
  const [warm, warmMs] = await timed(hydrate);

  const rows: [string, string, string][] = [
    ["first flush", secs(firstMs), `${first.uploadedBlobs} archive, ${(m1.layers[0]!.bytes / 1024 / 1024).toFixed(1)} MB stored for ${(tree.bytes / 1024 / 1024).toFixed(0)} MB`],
    ["flush, no change", secs(againMs), `changed=${again.changed}`],
    [`flush, ${tree.sample.length} files edited`, secs(deltaMs), `delta of ${m2.layers[m2.layers.length - 1]!.entries} entries, ${(m2.layers[m2.layers.length - 1]!.bytes / 1024).toFixed(1)} KB; full=${delta.full}`],
    ["cold hydrate", secs(coldMs), `${cold.mode}, ${(cold.downloadedBytes / 1024 / 1024).toFixed(1)} MB downloaded, ${m2.layers.length} layers`],
    ["warm hydrate", secs(warmMs), warm.mode],
  ];
  console.log("\nstep                         seconds   detail");
  for (const [step, s, detail] of rows) console.log(`${step.padEnd(28)} ${s.padStart(7)}   ${detail}`);
  console.log(`\nbudget: cold hydrate ${secs(coldMs)} s against ${BUDGET_S} s: ${coldMs / 1000 <= BUDGET_S ? "inside" : "OVER"}`);
  console.log(JSON.stringify({ files: tree.files, bytes: tree.bytes, store: STORE, firstFlushS: firstMs / 1000, noChangeFlushS: againMs / 1000, deltaFlushS: deltaMs / 1000, coldHydrateS: coldMs / 1000, warmHydrateS: warmMs / 1000, storedBytes: m1.layers[0]!.bytes }));
  failed = coldMs / 1000 > BUDGET_S || cold.mode !== "cold" || warm.mode !== "warm" || again.changed || delta.full;
} finally {
  await removeUnit(store, unitId).catch(() => {});
  rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
