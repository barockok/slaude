import { tmpdir } from "node:os";
import { join } from "node:path";
import { s3Config, storageMode } from "./config";
import { LocalObjectStore } from "./local";
import type { ObjectStore } from "./object-store";
import { S3ObjectStore } from "./s3";

export * from "./object-store";
export { storageMode, syncFlush, s3Config, syncStateDir, skillsMirror } from "./config";
export type { S3Config, StorageMode, SyncFlush } from "./config";
export { LocalObjectStore } from "./local";
export { S3ObjectStore } from "./s3";
export { storageSelfCheck } from "./selfcheck";
export * from "./manifest";
export * from "./tree-sync";
export * from "./units";
export { putInbox, drainInbox } from "./inbox";
export { gcSession, removeSession } from "./gc";
export type { GcOpts, GcResult } from "./gc";
export { DEFAULT_IGNORE, ignoreList, isIgnored } from "./ignore";

let shared: ObjectStore | undefined;

/**
 * The process's object store, or null in `fs` mode (nothing syncs). Built once.
 * `SLAUDE_STORAGE_LOCAL_DIR` points the `s3` mode at a directory instead of a
 * network endpoint, for single-machine rehearsals and tests only.
 */
export function objectStore(env: Record<string, string | undefined> = process.env): ObjectStore | null {
  if (storageMode(env) === "fs") return null;
  if (env === process.env && shared) return shared;
  const local = env.SLAUDE_STORAGE_LOCAL_DIR?.trim();
  const store = local ? new LocalObjectStore(local) : new S3ObjectStore(s3Config(env));
  if (env === process.env) shared = store;
  return store;
}

/** Test hook: forget the cached store. */
export function resetObjectStore(): void {
  shared = undefined;
}

/** A scratch directory for LocalObjectStore tests. */
export const scratchStoreDir = (name: string): string => join(tmpdir(), `slaude-store-${name}-${process.pid}-${Date.now()}`);
