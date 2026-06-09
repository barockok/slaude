import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackOpts {
  /** "127.0.0.1" locally; "0.0.0.0" in-container (mapped via docker -p). */
  host?: string;
  /** Explicit port, or 0 for an ephemeral OS-assigned port. */
  port?: number;
  expectedState: string;
  timeoutMs: number;
  callbackPath?: string;
}

export interface Loopback {
  port: number;
  callbackPath: string;
  /** Resolves with the auth code once the browser hits the callback; rejects on
   *  state mismatch or timeout. Always closes the listener before settling. */
  waitForCode(): Promise<string>;
}

export async function startLoopback(opts: LoopbackOpts): Promise<Loopback> {
  const callbackPath = opts.callbackPath ?? "/callback";
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host}`);
    if (u.pathname !== callbackPath) { res.statusCode = 404; res.end("not found"); return; }
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (state !== opts.expectedState) {
      res.statusCode = 400; res.end("state mismatch — you can close this tab");
      settle(() => rejectCode(new Error("OAuth callback state mismatch (possible CSRF)")));
      return;
    }
    if (!code) {
      res.statusCode = 400; res.end("missing code");
      settle(() => rejectCode(new Error("OAuth callback missing code")));
      return;
    }
    res.statusCode = 200; res.end("slaude connected — you can close this tab.");
    settle(() => resolveCode(code));
  });

  // Suppress unhandled-rejection noise — callers always consume via waitForCode().
  codePromise.catch(() => {});

  let settled = false;
  const timer = setTimeout(() => settle(() => rejectCode(new Error("OAuth loopback timeout — no callback received"))), opts.timeoutMs);
  function settle(fn: () => void) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    fn();
  }

  await new Promise<void>((res) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return { port, callbackPath, waitForCode: () => codePromise };
}
