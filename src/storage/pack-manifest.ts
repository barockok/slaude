import { StorageError } from "./object-store";
import type { Manifest } from "./manifest";

/**
 * Version 2 of a unit's manifest: a pack unit (`hm-…`, `wx-…`) is stored as a few
 * archives ("layers") instead of one object per file. Naming, epochs and "highest
 * wins" are those of the per-file manifest (see manifest.ts); only the body differs.
 *
 * Layers apply in order. The first is a full copy of the tree; each later one holds
 * the entries that changed since the one before and the paths that were removed.
 */

export interface PackLayer {
  /** sha256 of the archive, and its blob name. */
  hash: string;
  /** Stored size of the archive. */
  bytes: number;
  /** Entries in the archive (files, directories, links). */
  entries: number;
  /** Paths deleted since the previous layer, relative to the unit's root. Removed before the archive is applied. */
  removed: string[];
  /** Sum of the file sizes in the archive, before compression. Compared with `liveBytes` by the compaction rule. */
  rawBytes?: number;
}

export interface PackManifest {
  version: 2;
  kind: "pack";
  sessionId: string;
  epoch: number;
  seq: number;
  createdAt: number;
  layers: PackLayer[];
  /** Sum of the file sizes in the tree at this flush, before compression. */
  liveBytes?: number;
}

export type AnyManifest = Manifest | PackManifest;

export const isPackManifest = (m: AnyManifest): m is PackManifest => m.version === 2 && (m as PackManifest).kind === "pack";

/** A unit keeps at most this many layers before the next flush writes one full layer. */
export const PACK_MAX_LAYERS = 8;
/** Or when its layers hold more than this many times the live bytes. */
export const PACK_MAX_WASTE = 1.5;

/**
 * The compaction rule: more than `PACK_MAX_LAYERS` layers, or layers that hold more
 * than `PACK_MAX_WASTE` times what is live. Sizes are compared before compression
 * (`rawBytes` against `liveBytes`), so both sides measure the same thing; a manifest
 * without them is judged on its layer count alone.
 */
export function needsCompaction(m: Pick<PackManifest, "layers" | "liveBytes">): boolean {
  if (m.layers.length > PACK_MAX_LAYERS) return true;
  if (m.layers.length < 2 || m.liveBytes === undefined) return false;
  let raw = 0;
  for (const l of m.layers) {
    if (l.rawBytes === undefined) return false;
    raw += l.rawBytes;
  }
  return raw > PACK_MAX_WASTE * m.liveBytes;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Read a stored manifest of either kind. A pack manifest is checked field by field:
 * it decides which blobs are downloaded and which paths are deleted on a node.
 */
export function parseManifest(text: string): AnyManifest {
  const m = JSON.parse(text) as AnyManifest;
  if (m === null || typeof m !== "object") throw new StorageError("get", "manifest is not an object");
  if (m.version !== 2) return m;
  const p = m as PackManifest;
  if (p.kind !== "pack" || !Array.isArray(p.layers)) throw new StorageError("get", "version 2 manifest is not a pack manifest");
  for (const l of p.layers) {
    if (l === null || typeof l !== "object" || typeof l.hash !== "string" || !HASH_RE.test(l.hash)) throw new StorageError("get", "pack manifest holds a layer with a bad hash");
    if (!isCount(l.bytes) || !isCount(l.entries)) throw new StorageError("get", "pack manifest holds a layer with a bad size");
    if (!Array.isArray(l.removed) || l.removed.some((r) => typeof r !== "string")) throw new StorageError("get", "pack manifest holds a layer with a bad removed list");
  }
  return p;
}
