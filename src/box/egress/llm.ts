/**
 * A box's provider proxy (box spec, "The provider proxy is a hard
 * requirement").
 *
 * No credential enters a box, so the CLI inside runs with a placeholder and
 * talks to this reverse proxy (through box-init's loopback relay and a Unix
 * socket in the session's run directory). The node worker holds the real
 * provider credential and adds it here, outside the box.
 *
 *   - one upstream: the persona's provider base URL. Only the path and the
 *     query of a request are used; a request that names another host is
 *     served by the one upstream as a path, never by the host it named;
 *   - every credential header the box sent is removed before the real one is
 *     added, so the placeholder never reaches the provider;
 *   - the real credential is read per request, so a rotation reaches a
 *     running session without touching its sandbox;
 *   - a redirect is never followed and never passed on: a 3xx becomes a 502;
 *   - nothing that comes back carries the credential: a response header that
 *     contains it is dropped and the body is scrubbed as it streams;
 *   - no header value is ever logged.
 *
 * This is the ONLY place a credential is added on a box's behalf. The egress
 * proxy adds nothing (tests/box/no-credential-route.test.ts).
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderForm } from "../env";

export interface ProviderCredential {
  form: ProviderForm;
  value: string;
}

export interface ProviderProxyOpts {
  socketPath: string;
  /** The provider's base URL (`https://api.example.com`, optionally with a path prefix). Read per request. */
  upstream: string | (() => string | Promise<string>);
  /** The real credential, read per request. A throw answers 502; the box never learns why. */
  credential: () => ProviderCredential | Promise<ProviderCredential>;
  /** Mode of the socket file. Default 0666: the sandbox's user is not the node's. */
  socketMode?: number;
  /** TEST SEAM: the upstream fetch. */
  fetch?: typeof fetch;
  /** One line per request: method, path, status. Never a header value. */
  log?: (line: string) => void;
}

export interface ProviderProxy {
  socketPath: string;
  /** Requests forwarded so far. */
  requests(): number;
  close(): Promise<void>;
}

/** Hop-by-hop headers, and the ones the proxy sets itself. */
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host", "content-length"]);
/** Every header a credential could ride in from the box. All are removed; exactly one is set. */
export const INBOUND_CREDENTIAL_HEADERS: readonly string[] = ["x-api-key", "authorization", "anthropic-auth-token", "cookie", "x-auth-token", "x-goog-api-key", "api-key"];

/** The one header the real credential goes in, per form. */
export function credentialHeader(c: ProviderCredential): [string, string] {
  return c.form === "api-key" ? ["x-api-key", c.value] : ["authorization", `Bearer ${c.value}`];
}

const REDACTED = "[redacted]";

/** A stream that replaces every occurrence of `secret` in the bytes passing through, across chunk boundaries. */
export function scrubStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const needle = Buffer.from(secret, "utf8");
  const mark = Buffer.from(REDACTED, "utf8");
  let held: Buffer = Buffer.alloc(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (needle.length === 0) return controller.enqueue(chunk);
      let buf: Buffer = held.length ? Buffer.concat([held, Buffer.from(chunk)]) : Buffer.from(chunk);
      for (;;) {
        const at = buf.indexOf(needle);
        if (at < 0) break;
        if (at > 0) controller.enqueue(buf.subarray(0, at));
        controller.enqueue(mark);
        buf = buf.subarray(at + needle.length);
      }
      // Keep back what could be the start of a match that the next chunk completes.
      const keep = Math.min(buf.length, needle.length - 1);
      if (buf.length > keep) controller.enqueue(buf.subarray(0, buf.length - keep));
      held = Buffer.from(buf.subarray(buf.length - keep));
    },
    flush(controller) {
      if (held.length) controller.enqueue(held);
    },
  });
}

/** Join the upstream base and a request's path and query. The request's own scheme and host are never used. */
export function upstreamUrl(base: string, requestUrl: string): string {
  const b = new URL(base);
  if (b.protocol !== "https:" && b.protocol !== "http:") throw new Error("the provider base URL is not http or https");
  let path = "/";
  let search = "";
  try {
    const u = new URL(requestUrl, "http://box.invalid");
    path = u.pathname;
    search = u.search;
  } catch {
    /* an unparseable target is forwarded as the root path */
  }
  const prefix = b.pathname.replace(/\/+$/, "");
  return `${b.origin}${prefix}${path.startsWith("/") ? path : `/${path}`}${search}`;
}

const plain = (status: number, text: string): Response => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function startProviderProxy(opts: ProviderProxyOpts): Promise<ProviderProxy> {
  const doFetch = opts.fetch ?? fetch;
  let count = 0;
  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);

  const handler = async (req: Request): Promise<Response> => {
    let pathForLog = "/";
    try {
      pathForLog = new URL(req.url, "http://box.invalid").pathname;
    } catch {
      /* keep the root */
    }
    let cred: ProviderCredential;
    let target: string;
    try {
      cred = await opts.credential();
      if (!cred || typeof cred.value !== "string" || cred.value.length === 0) throw new Error("no credential");
      target = upstreamUrl(typeof opts.upstream === "function" ? await opts.upstream() : opts.upstream, req.url);
    } catch {
      opts.log?.(`${req.method} ${pathForLog} 502 (no provider route)`);
      return plain(502, "provider proxy: this session has no provider route");
    }

    const headers = new Headers();
    for (const [k, v] of req.headers) {
      const name = k.toLowerCase();
      if (HOP.has(name) || INBOUND_CREDENTIAL_HEADERS.includes(name)) continue;
      headers.set(k, v);
    }
    const [credName, credValue] = credentialHeader(cred);
    headers.set(credName, credValue);

    count++;
    let res: Response;
    try {
      // The request body is read whole (a model request is JSON, not a stream of unknown length), so the request
      // can be sent a second time. A connection kept from an earlier request may have been closed by the provider
      // since: the first write on it fails before any answer, and that is not the box's failure to pay for. Seen as
      // a turn that failed once in several runs against a local upstream. One retry, on a fresh connection.
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;
      const init = { method: req.method, headers, ...(body ? { body } : {}), redirect: "manual" } as RequestInit;
      try {
        res = await doFetch(target, init);
      } catch {
        opts.log?.(`${req.method} ${pathForLog} retry (no answer on the first connection)`);
        res = await doFetch(target, { ...init, keepalive: false } as RequestInit);
      }
    } catch {
      opts.log?.(`${req.method} ${pathForLog} 502 (upstream unreachable)`);
      return plain(502, "provider proxy: the provider could not be reached");
    }
    if (res.status >= 300 && res.status < 400) {
      // A redirect could name another host, and following it would replay the credential there.
      opts.log?.(`${req.method} ${pathForLog} 502 (redirect refused)`);
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to release */
      }
      return plain(502, "provider proxy: the provider answered with a redirect, which is refused");
    }

    const out = new Headers();
    for (const [k, v] of res.headers) {
      const name = k.toLowerCase();
      // The body below is already decoded and re-chunked, so its original length and encoding no longer hold.
      if (HOP.has(name) || name === "content-encoding" || name === "set-cookie") continue;
      if (v.includes(cred.value)) continue;
      out.set(k, v);
    }
    opts.log?.(`${req.method} ${pathForLog} ${res.status}`);
    return new Response(res.body ? res.body.pipeThrough(scrubStream(cred.value)) : null, { status: res.status, headers: out });
  };

  const server = Bun.serve({
    unix: opts.socketPath,
    // A model stream can be silent for a long time between events.
    idleTimeout: 0,
    fetch: handler,
    error: () => plain(502, "provider proxy: internal error"),
  } as never) as unknown as { stop(force?: boolean): Promise<void> | void };
  chmodSync(opts.socketPath, opts.socketMode ?? 0o666);

  return {
    socketPath: opts.socketPath,
    requests: () => count,
    async close() {
      await server.stop(true);
      try {
        unlinkSync(opts.socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}
