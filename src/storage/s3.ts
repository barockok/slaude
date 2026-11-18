import { S3Client } from "bun";
import { assertKey, StorageError, type ObjectInfo, type ObjectStore, type PutBody } from "./object-store";
import type { S3Config } from "./config";

const PAGE = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** A put moves a whole file, so it gets this many times a metadata request's deadline. */
const PUT_TIMEOUT_FACTOR = 10;

/** Reject if `p` has not settled in `ms`. The request itself is not cancelled (Bun's S3 client takes no signal), but the caller, which may hold a session lock, is released. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * An ObjectStore over any S3-compatible endpoint, using Bun's built-in S3
 * client (no SDK dependency). Large bodies go up as multipart uploads. Every
 * request has a deadline, because a black-holed endpoint would otherwise hold
 * the session and folder locks of the turn that called it.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #c: S3Client;
  readonly #prefix: string;
  readonly #timeout: number;

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
    this.#timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #key(key: string): string {
    assertKey(key);
    return this.#prefix + key;
  }

  async get(key: string, opts: { range?: [number, number] } = {}): Promise<ReadableStream<Uint8Array> | null> {
    const k = this.#key(key);
    try {
      let f = this.#c.file(k);
      if (!(await withDeadline(f.exists(), this.#timeout, `get ${key}`))) return null;
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
      const upload = async (): Promise<void> => {
        if (body instanceof Uint8Array || body instanceof Blob) {
          await f.write(body, type ? { type } : undefined);
          return;
        }
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
          try {
            await w.end();
          } catch {
            /* the upload failed; the original error is what matters */
          }
          throw e;
        }
      };
      await withDeadline(upload(), this.#timeout * PUT_TIMEOUT_FACTOR, `put ${key}`);
      const st = await withDeadline(f.stat(), this.#timeout, `stat ${key}`);
      return { etag: clean(st.etag) };
    } catch (e) {
      throw new StorageError("put", `${key}: ${msg(e)}`, { cause: e });
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const k = this.#key(key);
    try {
      const f = this.#c.file(k);
      if (!(await withDeadline(f.exists(), this.#timeout, `head ${key}`))) return null;
      const st = await withDeadline(f.stat(), this.#timeout, `stat ${key}`);
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
        res = await withDeadline(
          this.#c.list({ prefix: this.#prefix + prefix, maxKeys: PAGE, ...(startAfter ? { startAfter } : {}) }),
          this.#timeout,
          `list ${prefix}`,
        );
      } catch (e) {
        throw new StorageError("list", `${prefix}: ${msg(e)}`, { cause: e });
      }
      const items = res.contents ?? [];
      for (const it of items) {
        if (opts.limit !== undefined && n >= opts.limit) return;
        const modified = it.lastModified ? Date.parse(String(it.lastModified)) : NaN;
        yield {
          key: it.key.slice(this.#prefix.length),
          size: it.size ?? 0,
          etag: clean(it.eTag),
          ...(Number.isFinite(modified) ? { modified } : {}),
        };
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
        await withDeadline(this.#c.delete(k), this.#timeout, `delete ${key}`);
      } catch (e) {
        throw new StorageError("delete", `${key}: ${msg(e)}`, { cause: e });
      }
    }
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clean = (etag: string | undefined): string => (etag ?? "").replace(/^"|"$/g, "");
