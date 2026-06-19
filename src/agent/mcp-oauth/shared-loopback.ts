import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One always-on loopback HTTP listener that serves the OAuth callback for *every*
 * session, demultiplexing concurrent flows by their (signed) `state`.
 *
 * The per-flow ephemeral listener in `loopback.ts` binds a fresh port per connect;
 * this shares a single fixed port (so the redirect_uri is identical across flows
 * and can be registered once with the IdP) and routes each incoming callback to the
 * flow that owns its `state`. Pair with `state.ts` so the `state` carries — and
 * authenticates — the session id.
 *
 * redirect_uri is state-independent: `http://localhost:<port><callbackPath>`. The
 * IdP appends `?code=…&state=…`; we match `state` against the pending registry.
 */
export interface SharedLoopbackOpts {
  /** "127.0.0.1" locally; "0.0.0.0" in-container. */
  host?: string;
  /** Fixed listen port (default 3118). 0 → ephemeral OS-assigned (tests). */
  port?: number;
  callbackPath?: string;
}

interface Pending {
  resolve: (code: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SharedFlow {
  /** The fixed redirect_uri to register + send to the IdP. */
  redirectUri: string;
  /** Resolves with the code once a callback bearing this flow's state arrives;
   *  rejects on missing code, timeout, or listener shutdown. */
  waitForCode(): Promise<string>;
}

export class SharedLoopback {
  #server?: Server;
  #pending = new Map<string, Pending>();
  #host: string;
  #port: number;
  #callbackPath: string;
  #boundPort = 0;

  constructor(opts: SharedLoopbackOpts = {}) {
    this.#host = opts.host ?? "127.0.0.1";
    this.#port = opts.port ?? 3118;
    this.#callbackPath = opts.callbackPath ?? "/callback";
  }

  get port(): number {
    return this.#boundPort;
  }

  get callbackPath(): string {
    return this.#callbackPath;
  }

  /** Idempotent: a second call while listening is a no-op. */
  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      const u = new URL(req.url || "/", `http://${req.headers.host}`);
      if (u.pathname !== this.#callbackPath) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const state = u.searchParams.get("state") ?? "";
      const code = u.searchParams.get("code");
      const flow = this.#pending.get(state);
      if (!flow) {
        // Unknown/expired state — never resolve a flow we don't own.
        res.statusCode = 400;
        res.end("unknown or expired state — you can close this tab");
        return;
      }
      this.#pending.delete(state);
      clearTimeout(flow.timer);
      if (!code) {
        res.statusCode = 400;
        res.end("missing code");
        flow.reject(new Error("OAuth callback missing code"));
        return;
      }
      res.statusCode = 200;
      res.end("slaude connected — you can close this tab.");
      flow.resolve(code);
    });
    await new Promise<void>((resolve) => server.listen(this.#port, this.#host, resolve));
    this.#boundPort = (server.address() as AddressInfo).port;
    this.#server = server;
  }

  register(state: string, timeoutMs: number): SharedFlow {
    let resolve!: (c: string) => void;
    let reject!: (e: Error) => void;
    const p = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    p.catch(() => {}); // suppress unhandled-rejection noise; consumed via waitForCode()
    const timer = setTimeout(() => {
      if (this.#pending.delete(state)) reject(new Error("OAuth loopback timeout — no callback received"));
    }, timeoutMs);
    this.#pending.set(state, { resolve, reject, timer });
    return {
      redirectUri: `http://localhost:${this.#boundPort}${this.#callbackPath}`,
      waitForCode: () => p,
    };
  }

  async stop(): Promise<void> {
    for (const [state, flow] of this.#pending) {
      clearTimeout(flow.timer);
      flow.reject(new Error("OAuth loopback stopped"));
      this.#pending.delete(state);
    }
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let singleton: SharedLoopback | undefined;

/** Process-wide singleton. First call constructs (and the caller should `start()`). */
export function sharedLoopback(opts?: SharedLoopbackOpts): SharedLoopback {
  if (!singleton) singleton = new SharedLoopback(opts);
  return singleton;
}
