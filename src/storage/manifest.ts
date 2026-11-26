import { StorageError, getText, putText, type ObjectStore } from "./object-store";
import { parseManifest, type AnyManifest } from "./pack-manifest";

/**
 * A committed snapshot of one session's files. The manifest is written last in
 * a flush, so a flush that dies half way leaves orphan blobs and no visible
 * state. Blobs are content-addressed and never mutated.
 *
 * Fencing without conditional writes: a manifest is named by `<epoch>-<seq>`.
 * Readers take the highest epoch, then the highest seq within it, so a late
 * write from a node that lost the session lock carries a lower epoch and is
 * never the latest.
 */

export interface FileEntry {
  type: "file";
  hash: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface LinkEntry {
  type: "link";
  target: string;
}

export interface Manifest {
  version: 1;
  sessionId: string;
  epoch: number;
  seq: number;
  createdAt: number;
  /** Directories (relative to their root, `<root>/<path>`), so empty ones survive. */
  dirs: string[];
  /** Files and symlinks keyed `<root>/<path>`. */
  files: Record<string, FileEntry | LinkEntry>;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

export const manifestPrefix = (sessionId: string): string => `sessions/${sessionId}/manifest/`;
export const blobKey = (sessionId: string, hash: string): string => `sessions/${sessionId}/blobs/${hash}`;
export const blobPrefix = (sessionId: string): string => `sessions/${sessionId}/blobs/`;
export const manifestId = (epoch: number, seq: number): string => `${pad(epoch, 10)}-${pad(seq, 6)}`;
export const manifestKey = (sessionId: string, epoch: number, seq: number): string =>
  `${manifestPrefix(sessionId)}${manifestId(epoch, seq)}.json`;

const ID_RE = /(\d{10})-(\d{6})\.json$/;

export function parseManifestKey(key: string): { epoch: number; seq: number; id: string } | null {
  const m = ID_RE.exec(key);
  return m ? { epoch: Number(m[1]), seq: Number(m[2]), id: `${m[1]}-${m[2]}` } : null;
}

/** Every manifest key of a session, ascending (epoch, then seq). */
export async function listManifestKeys(store: ObjectStore, sessionId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const o of store.list(manifestPrefix(sessionId))) if (parseManifestKey(o.key)) keys.push(o.key);
  return keys.sort();
}

/** The highest epoch any stored manifest of a session carries, or 0 before the first flush. One list call, no reads. */
export async function latestEpoch(store: ObjectStore, sessionId: string): Promise<number> {
  const keys = await listManifestKeys(store, sessionId);
  const key = keys[keys.length - 1];
  return key ? parseManifestKey(key)!.epoch : 0;
}

/** The newest manifest by (epoch, seq), of either kind (per file, or pack), or null before the first flush. */
export async function latestManifest(store: ObjectStore, sessionId: string): Promise<{ id: string; manifest: AnyManifest } | null> {
  const keys = await listManifestKeys(store, sessionId);
  const key = keys[keys.length - 1];
  if (!key) return null;
  const text = await getText(store, key);
  if (text === null) return null;
  return { id: parseManifestKey(key)!.id, manifest: parseManifest(text) };
}

/** The newest manifest of a per-file unit. A pack manifest under that name is refused: the two formats never share a unit. */
export async function latestTreeManifest(store: ObjectStore, sessionId: string): Promise<{ id: string; manifest: Manifest } | null> {
  const latest = await latestManifest(store, sessionId);
  if (latest === null) return null;
  if (latest.manifest.version !== 1) throw new StorageError("get", `unit '${sessionId}' holds a pack manifest where a per-file one was expected`);
  return { id: latest.id, manifest: latest.manifest };
}

export async function writeManifest(store: ObjectStore, m: AnyManifest): Promise<string> {
  await putText(store, manifestKey(m.sessionId, m.epoch, m.seq), JSON.stringify(m));
  return manifestId(m.epoch, m.seq);
}
