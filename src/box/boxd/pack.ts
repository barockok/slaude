/**
 * The packer: walks a directory, builds an archive of what changed, and applies
 * archives back, confined to the directory (spec: docs/superpowers/specs/2026-11-24-box-design.md,
 * "The pack format"). It runs where the files are (the box supervisor); it holds no
 * credential and never talks to the object store. `src/storage/pack-sync.ts` is the
 * other half.
 *
 * The archive is a plain ustar tar with pax records for long names, compressed with
 * zstd when the runtime has the codec (Bun does: `node:zlib`), plain otherwise. Both
 * are done in this file, not by running `tar` and `zstd`: the reader then is the validator, so there is no second
 * parser whose view of a hostile archive could differ from the one that was checked,
 * and the same code runs on a developer's macOS (bsdtar) and on a node (GNU tar).
 * `apply` sniffs the zstd magic, so an uncompressed tar is read too.
 *
 * What an archive holds: regular files, directories, symlinks and hard links, with
 * mode and mtime (whole seconds). No owners, no extended attributes, no device
 * nodes: one user owns everything in a home or a workspace.
 *
 * An archive comes from a directory the agent controlled, so `apply` trusts nothing
 * in it: see `validateListing` and `apply`.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  lchownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import { isIgnored } from "../../storage/ignore";
import { PackQuotaError, type AppliedLayer, type PackFilter, type PackPort, type PackRequest, type PackUnitRef, type PackedLayer } from "../../storage/pack-sync";
import { RootMissingError } from "../../storage/tree-sync";

/** The runtime's zstd codec. Bun ships it; the type definitions in use do not declare it yet, and an older runtime may lack it. */
const zstd = zlib as unknown as { createZstdCompress?: () => Transform; createZstdDecompress?: () => Transform };

/** True when archives are compressed on this runtime. Without the codec they are written as plain tar. */
export const zstdAvailable = (): boolean => typeof zstd.createZstdCompress === "function" && typeof zstd.createZstdDecompress === "function";

/** An archive, a listing or a path that the packer refuses. Nothing was written past the point it was found. */
export class PackError extends Error {
  constructor(message: string) {
    super(`pack: ${message}`);
    this.name = "PackError";
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const under = (rel: string, prefix: string): boolean => rel === prefix || rel.startsWith(`${prefix}/`);

/**
 * Does the unit hold this path? For the workspace extras this is, by definition,
 * `isIgnored`: the per-file sync (`ws`) holds a path exactly when it is not ignored,
 * so the two units split a workspace with no overlap and no gap.
 */
export function selects(filter: PackFilter, rel: string): boolean {
  if (filter.kind === "ignored") return isIgnored(rel, filter.names);
  return !filter.exclude.some((ex) => under(rel, ex));
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export type EntryType = "file" | "dir" | "link";

export interface IndexEntry {
  type: EntryType;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  mode: number;
  nlink: number;
  /** A symlink's target. */
  target?: string;
}

/** Path (relative, `/`-separated) to what the scan saw there. */
export type PackIndex = Map<string, IndexEntry>;

function entryOf(st: Stats, abs: string): IndexEntry | null {
  const base = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), ctimeMs: Math.floor(st.ctimeMs), ino: st.ino, mode: st.mode & 0o7777, nlink: st.nlink };
  if (st.isSymbolicLink()) return { ...base, type: "link", size: 0, target: readlinkSync(abs) };
  if (st.isDirectory()) return { ...base, type: "dir", size: 0 };
  if (st.isFile()) return { ...base, type: "file" };
  return null; // sockets, pipes, devices: never stored
}

/**
 * Walk `root` and record every path the filter selects. Symlinks are recorded, never
 * followed. A path that disappears while it is walked is left out.
 */
export function scan(root: string, filter: PackFilter): PackIndex {
  const out: PackIndex = new Map();
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (selects(filter, r)) {
        const e = entryOf(st, p);
        if (!e) continue;
        out.set(r, e);
        if (e.type === "dir") walk(p, r);
      } else if (filter.kind === "ignored" && st.isDirectory()) {
        // Not ours, but an ignored tree may sit further down (`packages/a/node_modules`).
        walk(p, r);
      }
      // kind "all": an excluded path and everything below it are skipped.
    }
  };
  walk(root, "");
  return out;
}

/** Sum of the file sizes in an index, a hard-linked file counted once. */
export function liveBytes(index: PackIndex): number {
  let n = 0;
  const seen = new Set<number>();
  for (const e of index.values()) {
    if (e.type !== "file") continue;
    if (e.nlink > 1) {
      if (seen.has(e.ino)) continue;
      seen.add(e.ino);
    }
    n += e.size;
  }
  return n;
}

function same(a: IndexEntry, b: IndexEntry): boolean {
  if (a.type !== b.type || a.mode !== b.mode) return false;
  if (a.type === "dir") return true; // a directory's times move with its children, which are compared themselves
  if (a.type === "link") return a.target === b.target;
  // ctime catches a rewrite that restored the mtime, and a new hard link to an old file (the link count moved).
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.nlink === b.nlink;
}

/**
 * What a delta layer must carry to turn `prev` into `next`: the paths to archive and
 * the paths to delete first. A path whose type changed is in both, so applying the
 * layer never has to replace one kind of thing with another. Only the top of a
 * removed tree is listed.
 */
export function diff(prev: PackIndex, next: PackIndex): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const gone: string[] = [];
  for (const [path, e] of next) {
    const old = prev.get(path);
    if (!old || !same(old, e)) changed.push(path);
    if (old && old.type !== e.type) gone.push(path);
  }
  for (const path of prev.keys()) if (!next.has(path)) gone.push(path);
  gone.sort();
  const tops = new Set<string>();
  for (const path of gone) {
    const segs = path.split("/");
    let covered = false;
    for (let i = 1; i < segs.length && !covered; i++) covered = tops.has(segs.slice(0, i).join("/"));
    if (!covered) tops.add(path);
  }
  return { changed: changed.sort(), removed: [...tops] };
}

interface IndexFile {
  /** The manifest id this index was recorded for, or null. */
  base: string | null;
  entries: PackIndex;
}

type Row = [string, EntryType, number, number, number, number, number, number, string?];

export function saveIndex(path: string, base: string | null, entries: PackIndex): void {
  const rows: Row[] = [];
  for (const [p, e] of entries) rows.push(e.target === undefined ? [p, e.type, e.size, e.mtimeMs, e.ctimeMs, e.ino, e.mode, e.nlink] : [p, e.type, e.size, e.mtimeMs, e.ctimeMs, e.ino, e.mode, e.nlink, e.target]);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, base, rows }));
  renameSync(tmp, path);
}

/** The saved index, or null when there is none or it cannot be read (the next pack is then a full one). */
export function loadIndex(path: string): IndexFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: number; base?: string | null; rows?: Row[] };
    if (raw.version !== 1 || !Array.isArray(raw.rows)) return null;
    const entries: PackIndex = new Map();
    for (const [p, type, size, mtimeMs, ctimeMs, ino, mode, nlink, target] of raw.rows) {
      entries.set(p, { type, size, mtimeMs, ctimeMs, ino, mode, nlink, ...(target !== undefined ? { target } : {}) });
    }
    return { base: raw.base ?? null, entries };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tar: writing
// ---------------------------------------------------------------------------

const BLOCK = 512;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const READ_CHUNK = 256 * 1024;
const MAX_OCTAL_SIZE = 0o77777777777;
const enc = new TextEncoder();

/** The tar type flags an archive may carry. Everything else (devices, pipes, GNU extensions) is refused at read. */
export type TarType = "file" | "dir" | "link" | "hardlink";

export interface TarEntry {
  path: string;
  type: TarType;
  mode: number;
  size: number;
  /** Seconds. */
  mtime: number;
  /** A symlink's target, or the archive path a hard link points at. */
  linkname: string;
}

const FLAG: Record<TarType, string> = { file: "0", dir: "5", link: "2", hardlink: "1" };

function putString(block: Uint8Array, off: number, len: number, bytes: Uint8Array): void {
  block.set(bytes.subarray(0, len), off);
}

function putOctal(block: Uint8Array, off: number, len: number, n: number): void {
  putString(block, off, len, enc.encode(Math.max(0, Math.floor(n)).toString(8).padStart(len - 1, "0").slice(-(len - 1))));
}

function rawHeader(name: Uint8Array, typeflag: string, mode: number, size: number, mtime: number, linkname: Uint8Array): Uint8Array {
  const b = new Uint8Array(BLOCK);
  putString(b, 0, 100, name);
  putOctal(b, 100, 8, mode);
  putOctal(b, 108, 8, 0); // uid: owners are not stored
  putOctal(b, 116, 8, 0); // gid
  putOctal(b, 124, 12, Math.min(size, MAX_OCTAL_SIZE));
  putOctal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156);
  b[156] = typeflag.charCodeAt(0);
  putString(b, 157, 100, linkname);
  putString(b, 257, 6, enc.encode("ustar\0"));
  putString(b, 263, 2, enc.encode("00"));
  let sum = 0;
  for (const byte of b) sum += byte;
  putString(b, 148, 8, enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `));
  return b;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`);
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  const head = enc.encode(String(len));
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;

/**
 * The header block(s) of one entry: a pax record block first when the name, the link
 * name or the size does not fit a ustar header. Exported for tests, which build
 * archives this packer would never write.
 */
export function encodeHeader(e: TarEntry, typeflag: string = FLAG[e.type]): Uint8Array {
  const name = enc.encode(e.type === "dir" ? `${e.path}/` : e.path);
  const link = enc.encode(e.linkname);
  const records: Uint8Array[] = [];
  if (name.length > 100) records.push(paxRecord("path", e.path));
  if (link.length > 100) records.push(paxRecord("linkpath", e.linkname));
  if (e.size > MAX_OCTAL_SIZE) records.push(paxRecord("size", String(e.size)));
  const main = rawHeader(name, typeflag, e.mode, e.size, e.mtime, link);
  if (records.length === 0) return main;
  const bodyLen = records.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(BLOCK + padded(bodyLen) + BLOCK);
  out.set(rawHeader(enc.encode("PaxHeader"), "x", 0o644, bodyLen, e.mtime, new Uint8Array(0)));
  let off = BLOCK;
  for (const r of records) {
    out.set(r, off);
    off += r.length;
  }
  out.set(main, BLOCK + padded(bodyLen));
  return out;
}

export interface CreateOpts {
  spoolDir: string;
  /** zstd on by default where the runtime has it. Off writes a plain tar. */
  compress?: boolean;
}

export interface CreatedArchive {
  path: string;
  /** sha256 of the archive as stored. */
  hash: string;
  bytes: number;
  entries: number;
  /** Sum of the file sizes archived. */
  rawBytes: number;
  removed: string[];
  /**
   * Paths that changed, or went away, while they were archived. The archive holds
   * what was read (it is consistent per file, not as a whole); the caller must
   * archive these again at the next flush.
   */
  unsettled: string[];
}

/**
 * Archive `paths` (relative to `root`) into a new file in the spool. `removed` is
 * carried through unchanged: it is part of the layer, stored in the manifest.
 * Parents sort before their children, so an archive never names a child first.
 */
export async function create(root: string, paths: readonly string[], removed: readonly string[], opts: CreateOpts): Promise<CreatedArchive> {
  const sorted = [...paths].sort();
  const unsettled: string[] = [];
  let entries = 0;
  let rawBytes = 0;
  /** `dev:ino` of a multiply-linked file to the first path archived for it. */
  const firstLink = new Map<string, string>();

  async function* blocks(): AsyncGenerator<Uint8Array> {
    for (const rel of sorted) {
      const abs = join(root, rel);
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        unsettled.push(rel);
        continue;
      }
      const mtime = Math.floor(st.mtimeMs / 1000);
      // Set-uid, set-gid and sticky bits are not stored (and are stripped again at apply).
      const mode = st.mode & 0o777;
      if (st.isSymbolicLink()) {
        yield encodeHeader({ path: rel, type: "link", mode, size: 0, mtime, linkname: readlinkSync(abs) });
        entries++;
      } else if (st.isDirectory()) {
        yield encodeHeader({ path: rel, type: "dir", mode, size: 0, mtime, linkname: "" });
        entries++;
      } else if (st.isFile()) {
        const key = `${st.dev}:${st.ino}`;
        const first = st.nlink > 1 ? firstLink.get(key) : undefined;
        if (first !== undefined) {
          yield encodeHeader({ path: rel, type: "hardlink", mode, size: 0, mtime, linkname: first });
          entries++;
          continue;
        }
        let fd: number;
        try {
          fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch {
          unsettled.push(rel);
          continue;
        }
        try {
          const before = fstatSync(fd);
          if (!before.isFile()) {
            unsettled.push(rel);
            continue;
          }
          if (st.nlink > 1) firstLink.set(key, rel);
          const size = before.size;
          yield encodeHeader({ path: rel, type: "file", mode, size, mtime: Math.floor(before.mtimeMs / 1000), linkname: "" });
          let left = size;
          let short = false;
          while (left > 0) {
            const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, left));
            const n = short ? 0 : readSync(fd, buf, 0, buf.length, size - left);
            if (n === 0) {
              // The file shrank under us. The header already promised `size` bytes: fill with zeros and archive it again next time.
              short = true;
              buf.fill(0);
              yield buf;
              left -= buf.length;
              continue;
            }
            yield n === buf.length ? buf : buf.subarray(0, n);
            left -= n;
          }
          const pad = padded(size) - size;
          if (pad > 0) yield new Uint8Array(pad);
          const after = fstatSync(fd);
          if (short || after.size !== size || after.mtimeMs !== before.mtimeMs) unsettled.push(rel);
          entries++;
          rawBytes += size;
        } finally {
          closeSync(fd);
        }
      } else {
        unsettled.push(rel); // became a socket or a pipe since the scan
      }
    }
    yield new Uint8Array(BLOCK * 2);
  }

  mkdirSync(opts.spoolDir, { recursive: true });
  const path = join(opts.spoolDir, `out-${randomBytes(8).toString("hex")}.pack`);
  const fd = openSync(path, "wx", 0o600);
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  const store = (chunk: Uint8Array): void => {
    hasher.update(chunk);
    bytes += chunk.byteLength;
    for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off, chunk.byteLength - off);
  };
  const z = opts.compress === false || !zstdAvailable() ? null : zstd.createZstdCompress!();
  try {
    if (z === null) {
      for await (const block of blocks()) store(block);
    } else {
      let failure: Error | null = null;
      z.on("data", (chunk: Uint8Array) => {
        try {
          store(chunk);
        } catch (e) {
          failure = e as Error;
        }
      });
      z.on("error", (e: Error) => {
        failure ??= e;
      });
      // One write at a time, each awaited (see `pump`), in pieces large enough that the codec is not called per tar block.
      const batch = new Batcher(READ_CHUNK);
      for await (const block of blocks()) {
        const full = batch.add(block);
        if (full) await pump(z, full);
        if (failure) throw failure;
      }
      const rest = batch.take();
      if (rest) await pump(z, rest);
      await finish(z);
      if (failure) throw failure;
    }
  } catch (e) {
    z?.destroy();
    closeSync(fd);
    rmSync(path, { force: true });
    throw e;
  }
  closeSync(fd);
  return { path, hash: hasher.digest("hex"), bytes, entries, rawBytes, removed: [...removed], unsettled };
}

/**
 * The codec streams are driven by hand: one `write` at a time, the next only after the
 * stream called back, output taken from `data` events. Piping a file through the codec
 * and reading the result with an async iterator stalled on this runtime (Bun 1.3.11)
 * once an archive passed about 100 MB and the reader awaited between reads: the pipe's
 * pause and resume lost a wake-up. Explicit turns cannot.
 */
function pump(z: Transform, chunk: Uint8Array): Promise<void> {
  return new Promise((done) => {
    z.write(chunk, () => done());
  });
}

function finish(z: Transform): Promise<void> {
  return new Promise((done) => {
    if (z.destroyed || z.readableEnded) return done();
    z.once("end", () => done());
    z.once("error", () => done());
    z.once("close", () => done());
    z.end();
  });
}

/** Collects small chunks into pieces of at least `min` bytes. */
class Batcher {
  #parts: Uint8Array[] = [];
  #size = 0;
  readonly #min: number;
  constructor(min: number) {
    this.#min = min;
  }
  add(chunk: Uint8Array): Uint8Array | null {
    this.#parts.push(chunk);
    this.#size += chunk.byteLength;
    return this.#size >= this.#min ? this.take() : null;
  }
  take(): Uint8Array | null {
    if (this.#size === 0) return null;
    const out = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.#size);
    this.#parts = [];
    this.#size = 0;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Tar: reading
// ---------------------------------------------------------------------------

/** Exact reads from a stream of chunks. */
class ByteSource {
  readonly #it: AsyncIterator<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0);
  #off = 0;
  constructor(src: AsyncIterable<Uint8Array>) {
    this.#it = src[Symbol.asyncIterator]();
  }
  async #fill(): Promise<boolean> {
    for (;;) {
      const r = await this.#it.next();
      if (r.done) return false;
      if (r.value.byteLength === 0) continue;
      this.#buf = r.value;
      this.#off = 0;
      return true;
    }
  }
  /** Exactly `n` bytes; null at a clean end of stream; an error when the stream ends part way. */
  async read(n: number): Promise<Uint8Array | null> {
    if (this.#off + n <= this.#buf.byteLength) {
      const out = this.#buf.subarray(this.#off, this.#off + n);
      this.#off += n;
      return out;
    }
    const out = new Uint8Array(n);
    let have = 0;
    while (have < n) {
      if (this.#off >= this.#buf.byteLength && !(await this.#fill())) {
        if (have === 0) return null;
        throw new PackError("archive is truncated");
      }
      const take = Math.min(n - have, this.#buf.byteLength - this.#off);
      out.set(this.#buf.subarray(this.#off, this.#off + take), have);
      this.#off += take;
      have += take;
    }
    return out;
  }
  /** Pass the next `n` bytes to `sink` (or drop them). */
  async drain(n: number, sink?: (chunk: Uint8Array) => void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.#off >= this.#buf.byteLength && !(await this.#fill())) throw new PackError("archive is truncated");
      const take = Math.min(left, this.#buf.byteLength - this.#off);
      if (sink) sink(this.#buf.subarray(this.#off, this.#off + take));
      this.#off += take;
      left -= take;
    }
  }
}

const dec = new TextDecoder("utf-8", { fatal: false });

function fieldString(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(off, end));
}

function fieldOctal(b: Uint8Array, off: number, len: number, what: string): number {
  if ((b[off]! & 0x80) !== 0) throw new PackError(`archive uses a binary ${what} field`);
  const s = fieldString(b, off, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new PackError(`archive holds a bad ${what} field`);
  return parseInt(s, 8);
}

function parsePax(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off < body.length) {
    let sp = off;
    while (sp < body.length && body[sp] !== 0x20) sp++;
    const len = Number(dec.decode(body.subarray(off, sp)));
    if (!Number.isInteger(len) || len <= sp - off + 1 || off + len > body.length) throw new PackError("archive holds a bad pax record");
    const rec = dec.decode(body.subarray(sp + 1, off + len - 1));
    const eq = rec.indexOf("=");
    if (eq <= 0) throw new PackError("archive holds a bad pax record");
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    off += len;
  }
  return out;
}

const TYPE_OF: Record<string, TarType> = { "0": "file", "\0": "file", "5": "dir", "2": "link", "1": "hardlink" };
const TYPE_NAME: Record<string, string> = { "3": "a character device", "4": "a block device", "6": "a pipe", "7": "a contiguous file", g: "a global pax header", L: "a GNU long name", K: "a GNU long link" };
const MAX_PAX_BYTES = 1024 * 1024;

function openArchive(path: string): { chunks: AsyncIterable<Uint8Array>; close: () => void } {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(4);
  const n = readSync(fd, head, 0, 4, 0);
  const compressed = n === 4 && ZSTD_MAGIC.every((b, i) => head[i] === b);
  if (compressed && !zstd.createZstdDecompress) {
    closeSync(fd);
    throw new PackError("archive is zstd-compressed and this runtime has no zstd codec");
  }
  const z = compressed ? zstd.createZstdDecompress!() : null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    z?.destroy();
  };
  async function* raw(): AsyncGenerator<Uint8Array> {
    for (let pos = 0; ; ) {
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      const got = readSync(fd, buf, 0, READ_CHUNK, pos);
      if (got === 0) return;
      pos += got;
      yield got === READ_CHUNK ? buf : buf.subarray(0, got);
    }
  }
  if (z === null) return { chunks: raw(), close };

  const out: Uint8Array[] = [];
  let failure: Error | null = null;
  z.on("data", (chunk: Uint8Array) => out.push(chunk));
  z.on("error", (e: Error) => {
    failure ??= e;
  });
  const check = (): void => {
    if (failure) throw new PackError(`archive does not decompress: ${failure.message}`);
  };
  async function* inflated(): AsyncGenerator<Uint8Array> {
    for await (const chunk of raw()) {
      await pump(z!, chunk);
      check();
      while (out.length > 0) yield out.shift()!;
    }
    await finish(z!);
    check();
    while (out.length > 0) yield out.shift()!;
  }
  return { chunks: inflated(), close };
}

/**
 * Read an archive entry by entry. `onEntry` gets the header and must consume the
 * body through `body` (calling it without a sink skips it). A type flag outside
 * files, directories, symlinks and hard links is an error here, before any callback
 * for it runs.
 */
export async function readArchive(path: string, onEntry: OnEntry): Promise<void> {
  const archive = openArchive(path);
  try {
    await readEntries(new ByteSource(archive.chunks), onEntry);
  } finally {
    // The reader stops at the end marker (or at an error): whatever follows is never pulled through.
    archive.close();
  }
}

type OnEntry = (e: TarEntry, body: (sink?: (chunk: Uint8Array) => void) => Promise<void>) => Promise<void> | void;

async function readEntries(src: ByteSource, onEntry: OnEntry): Promise<void> {
  let pax: Map<string, string> | null = null;
  for (;;) {
    const h = await src.read(BLOCK);
    if (h === null) throw new PackError("archive has no end marker");
    if (h.every((b) => b === 0)) return; // the end marker; anything after it is ignored, never read
    const stored = fieldOctal(h, 148, 8, "checksum");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw new PackError("archive holds a header with a bad checksum");

    const flag = String.fromCharCode(h[156]!);
    let size = fieldOctal(h, 124, 12, "size");
    if (flag === "x") {
      if (size > MAX_PAX_BYTES) throw new PackError("archive holds an oversized pax header");
      const body = await src.read(size);
      if (body === null && size > 0) throw new PackError("archive is truncated");
      pax = parsePax(body ?? new Uint8Array(0));
      await src.drain(padded(size) - size);
      continue;
    }
    const type = TYPE_OF[flag];
    if (!type) throw new PackError(`archive holds ${TYPE_NAME[flag] ?? `an entry of unknown type '${flag.replace(/[^\x20-\x7e]/g, "?")}'`}: only files, directories, symlinks and hard links are allowed`);

    const prefix = fieldString(h, 345, 155);
    let name = fieldString(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    let linkname = fieldString(h, 157, 100);
    if (pax) {
      name = pax.get("path") ?? name;
      linkname = pax.get("linkpath") ?? linkname;
      const s = pax.get("size");
      if (s !== undefined) {
        if (!/^\d{1,15}$/.test(s)) throw new PackError("archive holds a bad pax size");
        size = Number(s);
      }
      pax = null;
    }
    if (type === "dir" && name.endsWith("/")) name = name.slice(0, -1);
    if (type !== "file") {
      if (size !== 0 && type !== "dir") throw new PackError(`archive holds a link with a body: '${printable(name)}'`);
      size = type === "dir" ? 0 : size;
    }
    const entry: TarEntry = { path: name, type, mode: fieldOctal(h, 100, 8, "mode"), size, mtime: fieldOctal(h, 136, 12, "mtime"), linkname };
    let consumed = false;
    await onEntry(entry, async (sink) => {
      if (consumed) return;
      consumed = true;
      await src.drain(size, sink);
      await src.drain(padded(size) - size);
    });
    if (!consumed) {
      await src.drain(size);
      await src.drain(padded(size) - size);
    }
  }
}

/** Every entry of an archive, bodies skipped. */
export async function listArchive(path: string): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  await readArchive(path, (e) => {
    out.push(e);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Validation and apply
// ---------------------------------------------------------------------------

const printable = (s: string): string => (s.length > 120 ? `${s.slice(0, 120)}...` : s).replace(/[^\x20-\x7e]/g, "?");

/** A relative path of plain segments: no leading `/`, no empty, `.` or `..` segment, no NUL. */
export function safeRel(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\0")) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * Check a listing before anything is written. Refused:
 *   - a path that is absolute, or holds an empty, `.` or `..` segment;
 *   - the same path twice;
 *   - a path below another entry of the same archive that is not a directory
 *     (a symlink or a file used as a directory), in either order;
 *   - a hard link whose target is not a regular file earlier in the same archive.
 * Entry types were already limited to files, directories, symlinks and hard links by
 * the reader. A symlink's target is not checked: it is stored as text and never
 * followed by `apply`.
 */
export function validateListing(entries: readonly TarEntry[]): void {
  const types = new Map<string, TarType>();
  const usedAsDir = new Set<string>();
  for (const e of entries) {
    if (!["file", "dir", "link", "hardlink"].includes(e.type)) throw new PackError(`entry type not allowed: '${printable(e.path)}'`);
    if (!safeRel(e.path)) throw new PackError(`unsafe path in archive: '${printable(e.path)}'`);
    if (types.has(e.path)) throw new PackError(`path appears twice in archive: '${printable(e.path)}'`);
    const segs = e.path.split("/");
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      const t = types.get(parent);
      if (t !== undefined && t !== "dir") throw new PackError(`'${printable(e.path)}' is below '${printable(parent)}', which is not a directory`);
      usedAsDir.add(parent);
    }
    if (e.type !== "dir" && usedAsDir.has(e.path)) throw new PackError(`'${printable(e.path)}' is used as a directory by another entry but is not one`);
    if (e.type === "hardlink") {
      if (!safeRel(e.linkname)) throw new PackError(`hard link '${printable(e.path)}' has an unsafe target`);
      if (types.get(e.linkname) !== "file") throw new PackError(`hard link '${printable(e.path)}' does not point at a regular file earlier in the archive`);
    }
    types.set(e.path, e.type);
  }
}

/** What earlier layers of one hydrate wrote, so a later layer can tell its own tree from what was there before. */
export interface ApplyState {
  written: Set<string>;
}

export interface ApplyOpts {
  /** Paths to delete before the archive is applied (the layer's `removed` list). */
  removed?: readonly string[];
  /** Entries and removals the filter does not select are skipped and counted, never written: one unit cannot touch another's paths. */
  filter?: PackFilter;
  /** Carry this across the layers of one hydrate. */
  state?: ApplyState;
  /**
   * `reject` (the default): a path that would go through anything but a real directory is an error.
   * `skip`: when the thing in the way was not written by these layers (another unit owns it), the entry
   * is left out and counted. What these layers wrote themselves is always an error.
   */
  foreign?: "reject" | "skip";
  /** Give every entry to this user. Only meaningful for a privileged packer; by default entries belong to whoever runs it. */
  owner?: { uid: number; gid: number };
}

export interface ApplyResult {
  written: number;
  skipped: number;
}

class Foreign extends Error {}

/** Give the owner write and search on a directory tree, so it can be deleted (a Go module cache is read-only on purpose). */
function makeWritable(p: string): void {
  const st = lstatOrNull(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  try {
    chmodSync(p, (st.mode & 0o777) | 0o700);
    for (const name of readdirSync(p)) makeWritable(join(p, name));
  } catch {
    /* the delete below reports what it could not do */
  }
}

/** Delete a path and everything below it. Never follows a symlink: a link is removed, not what it points at. */
export function forceRemove(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
    return;
  } catch {
    makeWritable(p);
  }
  rmSync(p, { recursive: true, force: true });
}

/**
 * Resolve `rel` under `rootReal` one segment at a time, never through a symlink:
 * every parent must be a real directory, checked with lstat. Missing parents are
 * created when `create` is set. Returns null when a parent is missing and may not be
 * created. This is what keeps a symlink planted by one layer from redirecting a
 * later write: the walk refuses it instead of following it.
 */
function confine(rootReal: string, rel: string, create: boolean, state: ApplyState, foreign: "reject" | "skip", loosened: Map<string, number>): string | null {
  const segs = rel.split("/");
  let cur = rootReal;
  let walked = "";
  for (const s of segs.slice(0, -1)) {
    cur = join(cur, s);
    walked = walked ? `${walked}/${s}` : s;
    let st: Stats | null = null;
    try {
      st = lstatSync(cur);
    } catch {
      st = null;
    }
    if (st === null) {
      if (!create) return null;
      mkdirSync(cur, { mode: 0o755 });
      state.written.add(walked);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      const what = st.isSymbolicLink() ? "a symlink" : "not a directory";
      if (foreign === "skip" && !state.written.has(walked)) throw new Foreign();
      throw new PackError(`'${printable(rel)}' goes through '${printable(walked)}', which is ${what}`);
    }
  }
  // The directory about to be written into may be read-only (a stored mode, as in a module cache): open it for the
  // length of this apply. It is a real directory inside the root, reached without crossing a link.
  if (cur !== rootReal) {
    const st = lstatOrNull(cur);
    if (st && (st.mode & 0o300) !== 0o300 && !loosened.has(cur)) {
      loosened.set(cur, st.mode & 0o777);
      chmodSync(cur, (st.mode & 0o777) | 0o700);
    }
  }
  return join(cur, segs[segs.length - 1]!);
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Apply one archive under `root`. The listing is validated in full first; then the
 * `removed` paths are deleted and the entries written, every path resolved inside
 * `root` (see `confine`). Rules while writing:
 *   - an existing path of another type is an error unless the layer removed it first
 *     (a type change always comes with a removal, see `diff`);
 *   - a file or a link that exists is unlinked and created anew, never written through;
 *   - set-uid, set-gid and sticky bits are dropped; nothing is ever chowned unless `owner` says so.
 * `root` must not be written by anyone else meanwhile: the sandbox is stopped when a unit is hydrated.
 */
export async function apply(archive: string, root: string, opts: ApplyOpts = {}): Promise<ApplyResult> {
  const listing = await listArchive(archive);
  validateListing(listing);
  const removed = opts.removed ?? [];
  for (const r of removed) if (!safeRel(r)) throw new PackError(`unsafe removed path: '${printable(r)}'`);

  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  const state = opts.state ?? { written: new Set<string>() };
  const foreign = opts.foreign ?? "reject";
  const mine = (rel: string): boolean => opts.filter === undefined || selects(opts.filter, rel);
  let written = 0;
  let skipped = 0;
  const loosened = new Map<string, number>();

  for (const r of removed) {
    if (!mine(r)) {
      skipped++;
      continue;
    }
    let dest: string | null;
    try {
      dest = confine(rootReal, r, false, state, foreign, loosened);
    } catch (e) {
      if (e instanceof Foreign) {
        skipped++;
        continue;
      }
      throw e;
    }
    if (dest === null) continue;
    forceRemove(dest);
    for (const w of state.written) if (under(w, r)) state.written.delete(w);
  }

  const own = (dest: string): void => {
    if (opts.owner) lchownSync(dest, opts.owner.uid, opts.owner.gid);
  };
  const dirs: [string, number, number][] = [];

  await readArchive(archive, async (e, body) => {
    if (!mine(e.path)) {
      skipped++;
      return;
    }
    let dest: string | null;
    try {
      dest = confine(rootReal, e.path, true, state, foreign, loosened);
    } catch (err) {
      if (err instanceof Foreign) {
        skipped++;
        return;
      }
      throw err;
    }
    if (dest === null) return;
    const mode = e.mode & 0o777;
    const existing = lstatOrNull(dest);
    const clash = (want: string): PackError => new PackError(`'${printable(e.path)}' is ${want} in the archive but something else on disk, and the layer did not remove it first`);

    if (e.type === "dir") {
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw clash("a directory");
      } else {
        mkdirSync(dest, { mode: 0o700 });
      }
      // Writable until its children are in; the stored mode goes on at the end.
      chmodSync(dest, mode | 0o700);
      own(dest);
      dirs.push([dest, mode, e.mtime]);
    } else if (e.type === "file") {
      if (existing) {
        if (!existing.isFile()) throw clash("a file");
        unlinkSync(dest);
      }
      const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await body((chunk) => {
          for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off, chunk.byteLength - off);
        });
        fchmodSync(fd, mode);
        futimesSync(fd, e.mtime, e.mtime);
      } finally {
        closeSync(fd);
      }
      own(dest);
    } else if (e.type === "link") {
      if (existing) {
        if (!existing.isSymbolicLink()) throw clash("a symlink");
        unlinkSync(dest);
      }
      symlinkSync(e.linkname, dest);
      own(dest);
    } else {
      // A hard link: the target was validated as a regular file earlier in this archive. Resolve it the same confined way
      // and check what is really there, since an entry in between may have been skipped.
      let target: string | null;
      try {
        target = confine(rootReal, e.linkname, false, state, foreign, loosened);
      } catch (err) {
        if (err instanceof Foreign) {
          skipped++;
          return;
        }
        throw err;
      }
      const tst = target === null ? null : lstatOrNull(target);
      if (target === null || !tst || !tst.isFile() || !state.written.has(e.linkname)) {
        skipped++;
        return;
      }
      if (existing) {
        if (!existing.isFile()) throw clash("a file");
        unlinkSync(dest);
      }
      linkSync(target, dest);
    }
    state.written.add(e.path);
    written++;
  });

  for (const [dir, mode] of loosened) {
    try {
      chmodSync(dir, mode);
    } catch {
      /* gone since */
    }
  }
  // Directory modes and times last, deepest first: writing a child needs a writable parent and moves its mtime.
  for (const [dest, mode, mtime] of dirs.reverse()) {
    chmodSync(dest, mode);
    utimesSync(dest, mtime, mtime);
  }
  return { written, skipped };
}

/**
 * Delete what the filter selects under `root`, and nothing else: the workspace's own
 * files stay when its extras are dropped, and a home's excluded paths stay too.
 */
export function clear(root: string, filter: PackFilter): void {
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = lstatOrNull(p);
      if (!st) continue;
      const real = st.isDirectory() && !st.isSymbolicLink();
      if (filter.kind === "ignored") {
        if (isIgnored(r, filter.names)) forceRemove(p);
        else if (real) walk(p, r);
        continue;
      }
      if (filter.exclude.some((ex) => under(r, ex))) continue;
      // A directory that holds an excluded path is emptied around it, not removed.
      if (real && filter.exclude.some((ex) => ex.startsWith(`${r}/`))) walk(p, r);
      else forceRemove(p);
    }
  };
  if (existsSync(root)) walk(root, "");
}

// ---------------------------------------------------------------------------
// The packer as the sync sees it
// ---------------------------------------------------------------------------

export interface LocalPackerOpts {
  spoolDir: string;
  compress?: boolean;
  owner?: { uid: number; gid: number };
}

/**
 * The packer in this process: what the box supervisor runs behind its protocol, and
 * what tests and a development machine use directly.
 */
export function localPacker(opts: LocalPackerOpts): PackPort {
  mkdirSync(opts.spoolDir, { recursive: true });
  return {
    spoolDir: opts.spoolDir,

    async pack(unit: PackUnitRef, req: PackRequest): Promise<PackedLayer | null> {
      // A missing directory is not an empty tree: committing it would wipe what is stored.
      if (!existsSync(unit.root)) throw new RootMissingError(unit.filter.kind === "ignored" ? "wx" : "hm", unit.root);
      const next = scan(unit.root, unit.filter);
      const live = liveBytes(next);
      if (req.maxLiveBytes !== undefined && live > req.maxLiveBytes) throw new PackQuotaError(live, req.maxLiveBytes);
      const saved = loadIndex(unit.indexPath);
      const usable = saved !== null && req.base !== null && saved.base === req.base;
      const delta = usable ? diff(saved.entries, next) : null;
      if (delta && delta.changed.length === 0 && delta.removed.length === 0) return null;
      const full = delta === null || req.compact;
      const archive = await create(unit.root, full ? [...next.keys()] : delta.changed, full ? [] : delta.removed, { spoolDir: opts.spoolDir, ...(opts.compress !== undefined ? { compress: opts.compress } : {}) });
      // What moved while it was read is recorded as unknown, so the next flush archives it again (or removes it).
      for (const p of archive.unsettled) {
        const e = next.get(p);
        if (e) next.set(p, { ...e, mtimeMs: -1, ctimeMs: -1 });
      }
      return {
        path: archive.path,
        hash: archive.hash,
        bytes: archive.bytes,
        entries: archive.entries,
        removed: archive.removed,
        rawBytes: archive.rawBytes,
        full,
        liveBytes: live,
        commit: (id: string) => saveIndex(unit.indexPath, id, next),
        dispose: () => rmSync(archive.path, { force: true }),
      };
    },

    async apply(unit: PackUnitRef, req: { id: string; layers: AppliedLayer[] }): Promise<{ liveBytes: number }> {
      // The index describes the tree being replaced: without it a half-applied tree can never pass for a known one.
      rmSync(unit.indexPath, { force: true });
      mkdirSync(unit.root, { recursive: true });
      clear(unit.root, unit.filter);
      const state: ApplyState = { written: new Set() };
      for (const l of req.layers) {
        const r = await apply(l.path, unit.root, { removed: l.removed, filter: unit.filter, state, foreign: "skip", ...(opts.owner ? { owner: opts.owner } : {}) });
        if (r.skipped > 0) console.error(`[pack] ${r.skipped} entr${r.skipped === 1 ? "y" : "ies"} of layer ${l.hash.slice(0, 12)} skipped: outside the unit, or blocked by a path another unit owns`);
      }
      const next = scan(unit.root, unit.filter);
      saveIndex(unit.indexPath, req.id, next);
      return { liveBytes: liveBytes(next) };
    },

    async clear(unit: PackUnitRef): Promise<void> {
      rmSync(unit.indexPath, { force: true });
      clear(unit.root, unit.filter);
    },
  };
}
