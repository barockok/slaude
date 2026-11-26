import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { blobKey, latestTreeManifest, manifestId, writeManifest, type FileEntry, type LinkEntry, type Manifest } from "./manifest";
import { DEFAULT_IGNORE, isIgnored } from "./ignore";
import { StorageError, type ObjectStore } from "./object-store";

/** A directory that syncs, named so manifests can address it (`ws`, `tx`). */
export interface Root {
  name: string;
  dir: string;
}

/** The flush lost its right to commit: a newer lock holder (higher epoch) exists. Nothing was written. */
export class FencedError extends Error {
  constructor(message = "flush fenced: a newer epoch owns this session") {
    super(message);
    this.name = "FencedError";
  }
}

/**
 * A sync root's directory is not there. A flush must not read that as "the tree is
 * empty" and commit it over stored state, so it refuses and writes nothing.
 */
export class RootMissingError extends StorageError {
  constructor(name: string, dir: string) {
    super("put", `sync root '${name}' (${dir}) is missing: refusing to commit an empty tree over stored state`);
    this.name = "RootMissingError";
  }
}

export interface FlushOpts {
  epoch: number;
  /** Asked once, just before the manifest is written. False aborts with FencedError. */
  isCurrent: () => boolean | Promise<boolean>;
  ignore?: readonly string[];
  concurrency?: number;
}

export interface FlushResult {
  /** The manifest id the session now stands at. */
  id: string;
  /** False when nothing differed from the latest manifest and no new one was written. */
  changed: boolean;
  uploadedBlobs: number;
  uploadedBytes: number;
}

export interface HydrateOpts {
  /** Where the id of the manifest this machine last matched is kept, outside every root. */
  markerPath: string;
  ignore?: readonly string[];
  concurrency?: number;
}

export interface HydrateResult {
  /** `warm`: the local copy already matched. `cold`: files were written. `empty`: nothing stored yet. */
  mode: "warm" | "cold" | "empty";
  id: string | null;
  downloadedBytes: number;
}

const ROOT_NAME = /^[a-z][a-z0-9]{0,15}$/;
const MAX_RETRY_SETTLE = 3;

function checkRoots(roots: readonly Root[]): void {
  const seen = new Set<string>();
  for (const r of roots) {
    if (!ROOT_NAME.test(r.name) || seen.has(r.name)) throw new StorageError("config", `bad or duplicate sync root name '${r.name}'`);
    seen.add(r.name);
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

async function sha256File(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

interface Scanned {
  dirs: string[];
  /** key `<root>/<rel>` to the local facts needed to decide on hashing and upload. */
  files: Map<string, { abs: string; entry: FileEntry | LinkEntry }>;
}

function scanRoot(root: Root, ignore: readonly string[], out: Scanned): void {
  const walk = (abs: string, rel: string): void => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (isIgnored(r, ignore)) continue;
      const p = join(abs, d.name);
      const st = lstatSync(p);
      const key = `${root.name}/${r}`;
      if (st.isSymbolicLink()) {
        out.files.set(key, { abs: p, entry: { type: "link", target: readlinkSync(p) } });
      } else if (st.isDirectory()) {
        out.dirs.push(key);
        walk(p, r);
      } else if (st.isFile()) {
        out.files.set(key, { abs: p, entry: { type: "file", hash: "", size: st.size, mode: st.mode & 0o777, mtimeMs: Math.floor(st.mtimeMs) } });
      }
    }
  };
  if (existsSync(root.dir)) walk(root.dir, "");
}

const sameEntry = (a: FileEntry | LinkEntry, b: FileEntry | LinkEntry): boolean =>
  a.type === "link" || b.type === "link"
    ? a.type === "link" && b.type === "link" && a.target === b.target
    : a.hash === b.hash && a.mode === b.mode && a.size === b.size;

/**
 * Commit the roots' current contents as a new manifest. Idempotent: a second
 * flush of an unchanged tree uploads nothing and writes nothing. The manifest
 * is the last write, after a fence check.
 */
export async function flushTree(store: ObjectStore, sessionId: string, roots: readonly Root[], opts: FlushOpts): Promise<FlushResult> {
  checkRoots(roots);
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  for (const r of roots) if (!existsSync(r.dir)) throw new RootMissingError(r.name, r.dir);
  const prev = await latestTreeManifest(store, sessionId);
  if (prev && prev.manifest.epoch > opts.epoch) throw new FencedError(`flush fenced: manifest epoch ${prev.manifest.epoch} is newer than ${opts.epoch}`);

  const scanned: Scanned = { dirs: [], files: new Map() };
  for (const r of roots) scanRoot(r, ignore, scanned);

  // Hash what changed since the last manifest; reuse the old hash when size and mtime match.
  const toHash: string[] = [];
  for (const [key, f] of scanned.files) {
    if (f.entry.type !== "file") continue;
    const old = prev?.manifest.files[key];
    if (old && old.type === "file" && old.size === f.entry.size && old.mtimeMs === f.entry.mtimeMs) f.entry.hash = old.hash;
    else toHash.push(key);
  }
  await pool(toHash, opts.concurrency ?? 8, async (key) => {
    const f = scanned.files.get(key)!;
    (f.entry as FileEntry).hash = await sha256File(f.abs);
  });

  const files: Record<string, FileEntry | LinkEntry> = {};
  for (const key of [...scanned.files.keys()].sort()) files[key] = scanned.files.get(key)!.entry;
  const dirs = scanned.dirs.slice().sort();

  if (prev) {
    const pk = Object.keys(prev.manifest.files);
    const same =
      pk.length === Object.keys(files).length &&
      JSON.stringify(prev.manifest.dirs) === JSON.stringify(dirs) &&
      pk.every((k) => files[k] !== undefined && sameEntry(prev.manifest.files[k]!, files[k]!));
    if (same) return { id: prev.id, changed: false, uploadedBlobs: 0, uploadedBytes: 0 };
  }

  // Upload the blobs the store does not already hold.
  const known = new Set<string>();
  if (prev) for (const e of Object.values(prev.manifest.files)) if (e.type === "file") known.add(e.hash);
  const need = new Map<string, string>(); // hash -> a path that has it
  for (const [key, f] of scanned.files) if (f.entry.type === "file" && !known.has(f.entry.hash) && !need.has(f.entry.hash)) need.set(f.entry.hash, key);
  let uploadedBlobs = 0;
  let uploadedBytes = 0;
  await pool([...need.entries()], opts.concurrency ?? 4, async ([hash, key]) => {
    if (await store.head(blobKey(sessionId, hash))) return;
    let f = scanned.files.get(key)!;
    for (let attempt = 0; ; attempt++) {
      const entry = f.entry as FileEntry;
      await store.put(blobKey(sessionId, entry.hash), Bun.file(f.abs));
      // The file may have been written while it uploaded; then its hash no longer names these bytes.
      const st = lstatSync(f.abs);
      if (st.size === entry.size && Math.floor(st.mtimeMs) === entry.mtimeMs) {
        uploadedBlobs++;
        uploadedBytes += entry.size;
        return;
      }
      if (attempt >= MAX_RETRY_SETTLE) throw new StorageError("put", `${key} kept changing while it was flushed`);
      await store.delete([blobKey(sessionId, entry.hash)]);
      const fresh: FileEntry = { type: "file", hash: await sha256File(f.abs), size: st.size, mode: st.mode & 0o777, mtimeMs: Math.floor(st.mtimeMs) };
      f = { abs: f.abs, entry: fresh };
      scanned.files.set(key, f);
      files[key] = fresh;
    }
  });

  if (!(await opts.isCurrent())) throw new FencedError();
  const seq = prev && prev.manifest.epoch === opts.epoch ? prev.manifest.seq + 1 : 1;
  const manifest: Manifest = { version: 1, sessionId, epoch: opts.epoch, seq, createdAt: Date.now(), dirs, files };
  const id = await writeManifest(store, manifest);
  return { id, changed: true, uploadedBlobs, uploadedBytes };
}

export function validRel(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Split a manifest key into its root and relative path, refusing anything that could leave the root. */
function splitKey(key: string, roots: Map<string, Root>): { root: Root; rel: string } {
  const i = key.indexOf("/");
  const root = i > 0 ? roots.get(key.slice(0, i)) : undefined;
  const rel = i > 0 ? key.slice(i + 1) : "";
  if (!root || !validRel(rel)) throw new StorageError("get", `manifest holds an unsafe path '${key}'`);
  return { root, rel };
}

/**
 * Create the parent directories of `rel` under `rootDir`. An ancestor that is a file or a
 * symlink here but a directory in the stored tree (a path changed type) is replaced by a
 * real directory: removing a symlink removes the link, never what it points at, and nothing
 * is ever written through one.
 */
export function ensureParents(rootDir: string, rel: string): string {
  mkdirSync(rootDir, { recursive: true });
  let cur = rootDir;
  const segs = rel.split("/");
  for (const s of segs.slice(0, -1)) {
    cur = join(cur, s);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      rmSync(cur, { force: true });
      mkdirSync(cur);
    }
  }
  return join(cur, segs[segs.length - 1]!);
}

export function readMarker(path: string): string | null {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

/**
 * Make the roots match the latest manifest. A no-op when the local marker
 * already names that manifest (the warm, same-node case). Files the manifest
 * does not hold are removed, so the result is the stored tree, not a merge.
 */
export async function hydrateTree(store: ObjectStore, sessionId: string, roots: readonly Root[], opts: HydrateOpts): Promise<HydrateResult> {
  checkRoots(roots);
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  for (const r of roots) mkdirSync(r.dir, { recursive: true });
  const latest = await latestTreeManifest(store, sessionId);
  if (!latest) return { mode: "empty", id: null, downloadedBytes: 0 };
  if (readMarker(opts.markerPath) === latest.id) return { mode: "warm", id: latest.id, downloadedBytes: 0 };
  // From here the local tree is being rewritten. If this dies half way, a marker naming the
  // old state would let the next hydrate call a hybrid tree warm; no marker forces a full pass.
  rmSync(opts.markerPath, { force: true });

  const byName = new Map(roots.map((r) => [r.name, r]));
  const m = latest.manifest;
  for (const d of m.dirs) {
    const { root, rel } = splitKey(d, byName);
    const p = ensureParents(root.dir, `${rel}/x`);
    mkdirSync(dirname(p), { recursive: true });
  }

  let downloadedBytes = 0;
  const fileKeys = Object.keys(m.files).filter((k) => m.files[k]!.type === "file");
  await pool(fileKeys, opts.concurrency ?? 4, async (key) => {
    const e = m.files[key] as FileEntry;
    const { root, rel } = splitKey(key, byName);
    const dest = ensureParents(root.dir, rel);
    try {
      const st = lstatSync(dest);
      if (st.isFile() && st.size === e.size && Math.abs(Math.floor(st.mtimeMs) - e.mtimeMs) < 2) {
        if ((st.mode & 0o777) !== e.mode) chmodSync(dest, e.mode);
        return;
      }
      if (st.isDirectory()) rmSync(dest, { recursive: true, force: true });
    } catch {
      /* not there yet */
    }
    const body = await store.get(blobKey(sessionId, e.hash));
    if (!body) throw new StorageError("get", `blob ${e.hash} for '${key}' is missing from the store`);
    const tmp = `${dest}.slaude-sync.${randomBytes(4).toString("hex")}`;
    try {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp));
      if (lstatSync(tmp).size !== e.size) throw new StorageError("get", `blob for '${key}' has the wrong size`);
      chmodSync(tmp, e.mode);
      utimesSync(tmp, e.mtimeMs / 1000, e.mtimeMs / 1000);
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    downloadedBytes += e.size;
  });

  for (const key of Object.keys(m.files)) {
    const e = m.files[key]!;
    if (e.type !== "link") continue;
    const { root, rel } = splitKey(key, byName);
    const dest = ensureParents(root.dir, rel);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(e.target, dest);
  }

  // Drop what the manifest does not hold.
  const local: Scanned = { dirs: [], files: new Map() };
  for (const r of roots) scanRoot(r, ignore, local);
  for (const [key, f] of local.files) if (!m.files[key]) rmSync(f.abs, { recursive: true, force: true });
  const keepDirs = new Set(m.dirs);
  for (const d of local.dirs.sort().reverse()) {
    if (keepDirs.has(d)) continue;
    const { root, rel } = splitKey(d, byName);
    const abs = join(root.dir, rel);
    if (resolve(abs) === resolve(root.dir)) continue;
    try {
      if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  mkdirSync(dirname(opts.markerPath), { recursive: true });
  writeFileSync(opts.markerPath, JSON.stringify({ id: latest.id }));
  return { mode: "cold", id: latest.id, downloadedBytes };
}

/** Record that this machine's copy matches `id` (after a successful flush), so the next hydrate is warm. */
export function writeMarker(markerPath: string, id: string): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ id }));
}

export { manifestId };
