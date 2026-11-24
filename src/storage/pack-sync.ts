import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { blobKey, latestManifest, writeManifest } from "./manifest";
import { StorageError, type ObjectStore } from "./object-store";
import { isPackManifest, needsCompaction, type PackLayer, type PackManifest } from "./pack-manifest";
import { FencedError, readMarker, validRel } from "./tree-sync";

/**
 * Flush and hydrate of a pack unit (`hm-…`, `wx-…`) against the object store.
 *
 * This side moves bytes and writes manifests: it holds the store's credentials. It
 * never opens a file inside the unit's directory. Walking the directory, building an
 * archive and applying one are the packer's work (`src/box/boxd/pack.ts`, run by the
 * box supervisor), reached through the two callbacks below, so the two sides can sit
 * in different processes.
 *
 * The rules are those of flushTree and hydrateTree: the fence check sits just before
 * the manifest write, a flush of an unchanged tree writes nothing, and a hydrate
 * clears the marker before it rewrites the local copy and writes it back at the end.
 */

/** Which paths under a root a pack unit holds. Plain data, so it can cross a process boundary. */
export type PackFilter =
  /** Everything under the root except the given paths and what lies below them (a home, minus `durable.exclude`). */
  | { kind: "all"; exclude: readonly string[] }
  /** Exactly the paths the per-file sync skips: any path with a segment in `names` (the workspace extras). */
  | { kind: "ignored"; names: readonly string[] };

export interface PackRequest {
  /** The manifest id the store stands at, or null before the first flush. A delta is only valid against a local index recorded for this id. */
  base: string | null;
  /** The compaction rule fired: if anything changed, write one full layer. */
  compact: boolean;
  /** Refuse (PackQuotaError) when the tree holds more than this many bytes. */
  maxLiveBytes?: number;
}

/** One archive in the spool, ready to upload. */
export interface PackedLayer {
  path: string;
  hash: string;
  bytes: number;
  entries: number;
  removed: string[];
  rawBytes: number;
  /** True when the archive is the whole tree: it replaces every earlier layer. */
  full: boolean;
  /** Sum of the file sizes in the tree. */
  liveBytes: number;
  /** The manifest `id` now holds this layer: the packer records its index against that id. Called once, after the manifest write. */
  commit(id: string): Promise<void> | void;
  /** Delete the spool file. Called once, whatever happened. */
  dispose(): Promise<void> | void;
}

/**
 * Build the next layer. Returns null when the tree matches the index recorded for
 * `base` (nothing to write). With no index for `base` the layer must be full.
 */
export type PackFn = (req: PackRequest) => Promise<PackedLayer | null>;

export interface PackFlushOpts {
  epoch: number;
  /** Asked once, just before the manifest is written. False aborts with FencedError. */
  isCurrent: () => boolean | Promise<boolean>;
  pack: PackFn;
  maxLiveBytes?: number;
}

export interface PackFlushResult {
  id: string;
  /** False when nothing differed and no manifest was written. */
  changed: boolean;
  uploadedBlobs: number;
  uploadedBytes: number;
  /** True when this flush wrote one full layer in place of the earlier ones. */
  full: boolean;
  /** Sum of the file sizes in the tree, when a layer was built. */
  liveBytes?: number;
}

/** The tree is over twice its soft limit: the pack is refused, nothing is written, and retrying cannot help until space is freed. */
export class PackQuotaError extends StorageError {
  constructor(
    readonly liveBytes: number,
    readonly maxBytes: number,
  ) {
    super("put", `pack refused: the tree holds ${liveBytes} bytes, over the ${maxBytes} byte ceiling`);
    this.name = "PackQuotaError";
  }
}

export interface AppliedLayer {
  /** The downloaded archive in the spool. */
  path: string;
  hash: string;
  removed: string[];
}

export interface PackHydrateOpts {
  /** Where the id of the manifest this machine last matched is kept, outside the unit's root. */
  markerPath: string;
  /** Where downloaded archives wait for the packer. Emptied of them before this returns. */
  spoolDir: string;
  /**
   * Replace the local copy with the layers applied in order (none: an empty tree), and record the
   * packer's index against `id`. Only called when the local copy does not already match.
   */
  apply: (req: { id: string; layers: AppliedLayer[] }) => Promise<{ liveBytes?: number } | void>;
}

export interface PackHydrateResult {
  mode: "warm" | "cold" | "empty";
  id: string | null;
  downloadedBytes: number;
  liveBytes?: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;

async function latestPack(store: ObjectStore, unitId: string): Promise<{ id: string; manifest: PackManifest } | null> {
  const latest = await latestManifest(store, unitId);
  if (latest === null) return null;
  if (!isPackManifest(latest.manifest)) throw new StorageError("get", `unit '${unitId}' holds a per-file manifest where a pack manifest was expected`);
  return { id: latest.id, manifest: latest.manifest };
}

/**
 * Commit the unit's current contents. Idempotent: a flush of an unchanged tree builds
 * nothing, uploads nothing and writes nothing. Otherwise one archive is uploaded and a
 * manifest is written last, after the fence check: with the layer appended, or, when
 * the packer wrote a full layer (first flush, no usable index, compaction), alone.
 */
export async function flushPack(store: ObjectStore, unitId: string, opts: PackFlushOpts): Promise<PackFlushResult> {
  const prev = await latestPack(store, unitId);
  if (prev && prev.manifest.epoch > opts.epoch) throw new FencedError(`flush fenced: manifest epoch ${prev.manifest.epoch} is newer than ${opts.epoch}`);

  const layer = await opts.pack({
    base: prev?.id ?? null,
    compact: prev ? needsCompaction(prev.manifest) : false,
    ...(opts.maxLiveBytes !== undefined ? { maxLiveBytes: opts.maxLiveBytes } : {}),
  });
  if (layer === null) {
    if (!prev) throw new StorageError("put", `packer reported no change for unit '${unitId}', which has nothing stored`);
    return { id: prev.id, changed: false, uploadedBlobs: 0, uploadedBytes: 0, full: false };
  }
  try {
    if (!HASH_RE.test(layer.hash)) throw new StorageError("put", "packer returned a layer with a bad hash");
    if (!layer.removed.every(validRel)) throw new StorageError("put", "packer returned a layer with an unsafe removed path");
    if (!layer.full && !prev) throw new StorageError("put", `packer returned a delta for unit '${unitId}', which has nothing stored`);

    let uploadedBlobs = 0;
    let uploadedBytes = 0;
    const key = blobKey(unitId, layer.hash);
    if (!(await store.head(key))) {
      await store.put(key, Bun.file(layer.path));
      uploadedBlobs = 1;
      uploadedBytes = layer.bytes;
    }

    if (!(await opts.isCurrent())) throw new FencedError();
    const entry: PackLayer = { hash: layer.hash, bytes: layer.bytes, entries: layer.entries, removed: layer.full ? [] : layer.removed, rawBytes: layer.rawBytes };
    const seq = prev && prev.manifest.epoch === opts.epoch ? prev.manifest.seq + 1 : 1;
    const manifest: PackManifest = {
      version: 2,
      kind: "pack",
      sessionId: unitId,
      epoch: opts.epoch,
      seq,
      createdAt: Date.now(),
      layers: layer.full || !prev ? [entry] : [...prev.manifest.layers, entry],
      liveBytes: layer.liveBytes,
    };
    const id = await writeManifest(store, manifest);
    try {
      await layer.commit(id);
    } catch (e) {
      // The store is committed. Without its index the packer writes a full layer next time, which is correct, only slower.
      console.error(`[pack-sync] could not record the index for unit=${unitId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { id, changed: true, uploadedBlobs, uploadedBytes, full: layer.full, liveBytes: layer.liveBytes };
  } finally {
    try {
      await layer.dispose();
    } catch {
      /* a leftover spool file costs disk, never the flush */
    }
  }
}

/** Download one archive into the spool, checking its size and hash on the way: what the packer is handed is what the manifest names. */
async function fetchLayer(store: ObjectStore, unitId: string, layer: PackLayer, spoolDir: string): Promise<string> {
  const body = await store.get(blobKey(unitId, layer.hash));
  if (!body) throw new StorageError("get", `layer ${layer.hash} of unit '${unitId}' is missing from the store`);
  const path = join(spoolDir, `in-${layer.hash.slice(0, 16)}-${randomBytes(4).toString("hex")}.pack`);
  const fd = openSync(path, "wx", 0o600);
  const h = new Bun.CryptoHasher("sha256");
  let size = 0;
  try {
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        size += chunk.byteLength;
        for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off, chunk.byteLength - off);
      }
    } finally {
      closeSync(fd);
    }
    if (size !== layer.bytes) throw new StorageError("get", `layer ${layer.hash} of unit '${unitId}' has the wrong size`);
    if (h.digest("hex") !== layer.hash) throw new StorageError("get", `layer ${layer.hash} of unit '${unitId}' does not match its hash`);
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
  return path;
}

/**
 * Make the local copy match the latest manifest. A no-op when the marker already names
 * it (the warm, same-node case: a parked resume). Otherwise every layer is downloaded
 * and the packer rebuilds the tree from them, so the result is the stored tree, not a merge.
 */
export async function hydratePack(store: ObjectStore, unitId: string, opts: PackHydrateOpts): Promise<PackHydrateResult> {
  const latest = await latestPack(store, unitId);
  if (!latest) return { mode: "empty", id: null, downloadedBytes: 0 };
  if (readMarker(opts.markerPath) === latest.id) return { mode: "warm", id: latest.id, downloadedBytes: 0 };
  // From here the local copy is being rewritten: a marker naming the old state would let the next hydrate call a hybrid tree warm.
  rmSync(opts.markerPath, { force: true });

  mkdirSync(opts.spoolDir, { recursive: true });
  const layers: AppliedLayer[] = [];
  let downloadedBytes = 0;
  try {
    for (const l of latest.manifest.layers) {
      if (!l.removed.every(validRel)) throw new StorageError("get", `layer ${l.hash} of unit '${unitId}' names an unsafe removed path`);
      layers.push({ path: await fetchLayer(store, unitId, l, opts.spoolDir), hash: l.hash, removed: l.removed });
      downloadedBytes += l.bytes;
    }
    const applied = await opts.apply({ id: latest.id, layers });
    mkdirSync(dirname(opts.markerPath), { recursive: true });
    writeFileSync(opts.markerPath, JSON.stringify({ id: latest.id }));
    const liveBytes = applied?.liveBytes ?? latest.manifest.liveBytes;
    return { mode: "cold", id: latest.id, downloadedBytes, ...(liveBytes !== undefined ? { liveBytes } : {}) };
  } finally {
    for (const l of layers) rmSync(l.path, { force: true });
  }
}
