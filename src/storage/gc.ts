import { blobPrefix, listManifestKeys, manifestPrefix, type FileEntry } from "./manifest";
import { isPackManifest, parseManifest } from "./pack-manifest";
import { getText, type ObjectStore } from "./object-store";

export interface GcOpts {
  /** Newest manifests to keep. */
  keep?: number;
  /** Blobs younger than this are never deleted: an in-flight flush has uploaded them but not yet written its manifest. */
  graceMs?: number;
  now?: number;
}

export interface GcResult {
  manifestsDeleted: number;
  blobsDeleted: number;
}

/** Keep the newest manifests of one session and delete the blobs none of them reference. */
export async function gcSession(store: ObjectStore, sessionId: string, opts: GcOpts = {}): Promise<GcResult> {
  const keep = Math.max(1, opts.keep ?? 5);
  const graceMs = opts.graceMs ?? 3_600_000;
  const now = opts.now ?? Date.now();
  const keys = await listManifestKeys(store, sessionId);
  const retained = keys.slice(-keep);
  const dropped = keys.slice(0, Math.max(0, keys.length - keep));

  const live = new Set<string>();
  for (const k of retained) {
    const text = await getText(store, k);
    if (text === null) continue;
    const m = parseManifest(text);
    // A pack manifest references archives, one per layer; a per-file manifest references one blob per file.
    if (isPackManifest(m)) for (const l of m.layers) live.add(l.hash);
    else for (const e of Object.values(m.files)) if (e.type === "file") live.add((e as FileEntry).hash);
  }
  if (dropped.length > 0) await store.delete(dropped);

  const stale: string[] = [];
  for await (const o of store.list(blobPrefix(sessionId))) {
    const hash = o.key.slice(blobPrefix(sessionId).length);
    if (live.has(hash)) continue;
    if (o.modified === undefined || now - o.modified < graceMs) continue;
    stale.push(o.key);
  }
  if (stale.length > 0) await store.delete(stale);
  return { manifestsDeleted: dropped.length, blobsDeleted: stale.length };
}

/** Delete everything stored for one unit (`ws-…`, `tx-…`, `wx-…` or `hm-…`; a unit id, never a bare session id). */
export async function removeUnit(store: ObjectStore, unitId: string): Promise<number> {
  const keys: string[] = [];
  for await (const o of store.list(`sessions/${unitId}/`)) keys.push(o.key);
  if (keys.length > 0) await store.delete(keys);
  return keys.length;
}

export { manifestPrefix };
