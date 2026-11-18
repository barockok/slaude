import { S3Client } from "bun";
import { assertKey, StorageError, type ObjectInfo, type ObjectStore, type PutBody } from "./object-store";
import type { S3Config } from "./config";

const PAGE = 1000;

/**
 * An ObjectStore over any S3-compatible endpoint, using Bun's built-in S3
 * client (no SDK dependency). Large bodies go up as multipart uploads.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #c: S3Client;
  readonly #prefix: string;

  constructor(cfg: S3Config) {
    this.#c = new S3Client({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucket: cfg.bucket,
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      virtualHostedStyle: !cfg.pathStyle,
    });
    this.#prefix = cfg.prefix ? `${cfg.prefix}/` : "";
  }

  #key(key: string): string {
    assertKey(key);
    return this.#prefix + key;
  }

  async get(key: string, opts: { range?: [number, number] } = {}): Promise<ReadableStream<Uint8Array> | null> {
    const k = this.#key(key);
    try {
      let f = this.#c.file(k);
      if (!(await f.exists())) return null;
      if (opts.range) f = f.slice(opts.range[0], opts.range[1] + 1);
      return f.stream();
    } catch (e) {
      throw new StorageError("get", `${key}: ${msg(e)}`, { cause: e });
    }
  }

  async put(key: string, body: PutBody, opts: { contentType?: string } = {}): Promise<{ etag: string }> {
    const k = this.#key(key);
    try {
      const f = this.#c.file(k);
      const type = opts.contentType;
      if (body instanceof Uint8Array || body instanceof Blob) {
        await f.write(body, type ? { type } : undefined);
      } else {
        const w = f.writer(type ? { type } : undefined);
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            w.write(value);
            await w.flush();
          }
          await w.end();
        } catch (e) {
          try { await w.end(); } catch { /* the upload failed; the original error is what matters */ }
          throw e;
        }
      }
      const st = await f.stat();
      return { etag: clean(st.etag) };
    } catch (e) {
      throw new StorageError("put", `${key}: ${msg(e)}`, { cause: e });
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const k = this.#key(key);
    try {
      const f = this.#c.file(k);
      if (!(await f.exists())) return null;
      const st = await f.stat();
      return { size: st.size, etag: clean(st.etag) };
    } catch (e) {
      throw new StorageError("head", `${key}: ${msg(e)}`, { cause: e });
    }
  }

  async *list(prefix: string, opts: { after?: string; limit?: number } = {}): AsyncIterable<ObjectInfo> {
    if (prefix !== "") assertKey(prefix.replace(/\/$/, "") || "x");
    let startAfter = opts.after !== undefined ? this.#prefix + opts.after : undefined;
    let n = 0;
    for (;;) {
      let res;
      try {
        res = await this.#c.list({ prefix: this.#prefix + prefix, maxKeys: PAGE, ...(startAfter ? { startAfter } : {}) });
      } catch (e) {
        throw new StorageError("list", `${prefix}: ${msg(e)}`, { cause: e });
      }
      const items = res.contents ?? [];
      for (const it of items) {
        if (opts.limit !== undefined && n >= opts.limit) return;
        yield { key: it.key.slice(this.#prefix.length), size: it.size ?? 0, etag: clean(it.eTag) };
        n++;
      }
      if (!res.isTruncated || items.length === 0) return;
      startAfter = items[items.length - 1]!.key;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      const k = this.#key(key);
      try {
        await this.#c.delete(k);
      } catch (e) {
        throw new StorageError("delete", `${key}: ${msg(e)}`, { cause: e });
      }
    }
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clean = (etag: string | undefined): string => (etag ?? "").replace(/^"|"$/g, "");
