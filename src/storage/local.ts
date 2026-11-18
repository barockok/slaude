import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertKey, StorageError, type ObjectInfo, type ObjectStore, type PutBody } from "./object-store";

/**
 * An ObjectStore over a directory. For mono, unit tests and the contract suite.
 * Writes are atomic (temp file in the same directory, then rename), so a reader
 * never sees half an object.
 */
export class LocalObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
  }

  #path(key: string): string {
    assertKey(key);
    const p = resolve(this.#root, key);
    if (p !== this.#root && !p.startsWith(this.#root + sep)) throw new StorageError("config", `key escapes the store: '${key}'`);
    return p;
  }

  #etag(p: string): string {
    const st = statSync(p);
    return `${st.size}-${Math.floor(st.mtimeMs)}`;
  }

  async get(key: string, opts: { range?: [number, number] } = {}): Promise<ReadableStream<Uint8Array> | null> {
    const p = this.#path(key);
    let st;
    try {
      st = statSync(p);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const range = opts.range;
    const stream = createReadStream(p, range ? { start: range[0], end: range[1] } : {});
    return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  }

  async put(key: string, body: PutBody): Promise<{ etag: string }> {
    const p = this.#path(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      const src =
        body instanceof Uint8Array
          ? Readable.from([body])
          : body instanceof Blob
            ? Readable.fromWeb(body.stream() as never)
            : Readable.fromWeb(body as never);
      await pipeline(src, createWriteStream(tmp));
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new StorageError("put", `${key}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return { etag: this.#etag(p) };
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const p = this.#path(key);
    try {
      const st = statSync(p);
      if (!st.isFile()) return null;
      return { size: st.size, etag: this.#etag(p) };
    } catch {
      return null;
    }
  }

  async *list(prefix: string, opts: { after?: string; limit?: number } = {}): AsyncIterable<ObjectInfo> {
    const keys: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (!/\.tmp-[0-9a-f]{12}$/.test(name)) keys.push(relative(this.#root, full).split(sep).join("/"));
      }
    };
    walk(this.#root);
    keys.sort();
    let n = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      if (opts.after !== undefined && key <= opts.after) continue;
      if (opts.limit !== undefined && n >= opts.limit) return;
      const p = join(this.#root, key);
      yield { key, size: statSync(p).size, etag: this.#etag(p) };
      n++;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) rmSync(this.#path(key), { force: true });
  }
}
