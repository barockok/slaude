/**
 * The storage seam for remote filesystem sync. Only the baseline S3 API is
 * assumed (get, put, head, list, delete, multipart): no conditional writes, no
 * provider-specific feature, so any S3-compatible endpoint works.
 *
 * Keys are `/`-separated, relative to the store's own prefix, never start with
 * `/` and never contain `..` segments (assertKey refuses both).
 */

export type PutBody = Uint8Array | ReadableStream<Uint8Array> | Blob;

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
}

export interface ObjectStore {
  /** The object as a byte stream, or null when it does not exist. `range` is inclusive on both ends. */
  get(key: string, opts?: { range?: [number, number] }): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, body: PutBody, opts?: { contentType?: string }): Promise<{ etag: string }>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  /** Keys under `prefix`, ascending, strictly after `after` when given. */
  list(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<ObjectInfo>;
  /** Missing keys are not an error. */
  delete(keys: string[]): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    readonly op: "get" | "put" | "head" | "list" | "delete" | "config",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`storage ${op}: ${message}`, options);
    this.name = "StorageError";
  }
}

/** Refuse keys that could leave the store's namespace or confuse a backend. */
export function assertKey(key: string): void {
  if (key === "" || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new StorageError("config", `invalid object key '${key}'`);
  }
  for (const seg of key.split("/")) {
    if (seg === ".." || seg === ".") throw new StorageError("config", `invalid object key '${key}'`);
  }
}

/** Read a whole object into memory. For small objects (manifests, skill files). */
export async function getBytes(store: ObjectStore, key: string): Promise<Uint8Array | null> {
  const s = await store.get(key);
  if (!s) return null;
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function getText(store: ObjectStore, key: string): Promise<string | null> {
  const b = await getBytes(store, key);
  return b === null ? null : new TextDecoder().decode(b);
}

export async function putText(store: ObjectStore, key: string, text: string, contentType = "application/json"): Promise<{ etag: string }> {
  return store.put(key, new TextEncoder().encode(text), { contentType });
}

/** Every object under a prefix, collected. For small listings. */
export async function listAll(store: ObjectStore, prefix: string): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  for await (const o of store.list(prefix)) out.push(o);
  return out;
}
