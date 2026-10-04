/**
 * The MCP bridge, gateway side (WS-C §4.2): the gateway is the MCP CLIENT to a
 * persona's remote (`type: "http"`) servers, and a node relays the agent's
 * `tools/list` and `tools/call` here over the tool plane. The credential, its
 * refresh and the choice between the agent's and a person's identity never
 * leave the gateway.
 *
 * Which credential, per call (§4.2.4), from the job token's signed `runAs`:
 *
 *   runAs = agent                 the agent's OAuth entry for S, else the
 *                                 config's static headers
 *   runAs = user, S private       the user's OAuth entry ONLY: never the
 *                                 agent's, never static headers, and the URL's
 *                                 query/userinfo stripped (clearCredentials).
 *                                 No account or no grant: a "connect S" tool
 *                                 error, never a fallback to the agent
 *   runAs = user, S not private   the user's OAuth entry if present, else the
 *                                 config's static headers
 *
 * "Private" is exactly what privateOverrides does in mono: S is named in
 * `privateServices` and the turn runs as a person (a 1:1 lock, or a cron job's
 * captured initiator; dispatch already signed whichever wins into runAs). The
 * owner is re-derived on EVERY call, so an agent turn and a user turn in one
 * live session reach the upstream with different credentials, and upstream
 * sessions are pooled per (owner, server, config) and never shared.
 *
 * OAuth credentials are keyed exactly as connect stores them:
 * oauthKey(name, {type, url, headers}) over the configured server. A stored
 * entry is attached only when its own serverUrl has the configured URL's
 * origin (the origin pinned at connect); every request of a pooled client goes
 * through the outbound policy pinned to that origin, never follows a redirect,
 * and is checked against private, loopback, link-local and metadata addresses
 * after DNS.
 *
 * Failures are tool errors with FIXED text, never an upstream error body: an
 * upstream 401 refreshes once (the shared single-flight refresher) and retries
 * once; a failed refresh, or a server that still refuses, answers
 * {@link reauthText} and asks the gateway to post the existing connect card in
 * the thread, at most once per (session, server) per window.
 *
 * Not bridged (§4.2.9): server notifications (the standalone SSE stream is
 * never opened), sampling, prompts and resources.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JobClaims } from "../api/auth";
import { parseRunAs, type CredentialOwner } from "../../agent/credential-owner";
import { oauthKey, type StoredEntry } from "../../agent/mcp-oauth/store";
import { accountForSlackUser } from "../../db/accounts";
import { credentialsFor as credentialsForDefault } from "../../db/mcp-credentials";
import { env } from "../../config/env";
import { OutboundBlockedError, policyFetch, type OutboundPolicyOptions } from "../../net/outbound-policy";
import { clearCredentials, oauthHttpServers, type ExternalMcp } from "./external-mcp";
import { defaultCredentialRefresher, sha256Hex, type makeCredentialRefresher } from "./credential-refresh";

// ── fixed texts (never an upstream body) ────────────────────────────────────

export const reauthText = (server: string) => `this agent's connection to ${server} needs to be re-authorised`;
export const connectText = (server: string) =>
  `connect ${server}: this conversation runs as you, and ${server} uses your own connection, which is not set up yet`;
export const unavailableText = (server: string) => `${server} is unavailable right now; try again later`;
export const timeoutText = (server: string, ms: number) => `${server} did not answer within ${Math.ceil(ms / 1000)}s`;
export const cancelledText = (server: string) => `the call to ${server} was cancelled`;
export const busyText = (server: string) => `too many MCP calls are in flight for this identity; ${server} was not called`;
export const truncatedText = (size: number, cap: number) =>
  `[result truncated by the MCP bridge: ${size} bytes is over the ${cap}-byte limit]`;

export type CallToolResult = {
  content?: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
};

export interface ListOutcome {
  tools: unknown[];
  instructions?: string;
  serverInfo?: { name: string; version: string; [k: string]: unknown };
  /** Set when the list could not be fetched: the fixed reason is in `instructions`. */
  unavailable?: true;
}

/** The request was refused before any upstream contact (the route answers 4xx). */
export class BridgeRefused extends Error {
  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRefused";
  }
}

/** The one message for "no such server" and "not bridged for this persona":
 *  the two must look the same from a node. */
export const NOT_MOUNTED = "no such MCP server for this agent";

// ── credential choice ───────────────────────────────────────────────────────

export interface BridgeServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export type BridgeCredential =
  | {
      kind: "oauth";
      owner: CredentialOwner;
      key: string;
      entry: StoredEntry;
      url: string;
      /** Headers to send, Authorization included. */
      headers: Record<string, string>;
      /** Whose session this is, for the pool. */
      ownerKey: string;
    }
  | { kind: "static"; url: string; headers: Record<string, string>; ownerKey: string }
  | { kind: "connect" };

export interface CredentialDeps {
  accountFor(teamId: string, slackUserId: string): Promise<{ id: string } | null>;
  credentialsFor(owner: CredentialOwner): Promise<Record<string, StoredEntry>>;
}

const withoutAuthorization = (h: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() !== "authorization") out[k] = v;
  return out;
};

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** A stored entry is attached only to the origin it was granted for. */
function pinned(entry: StoredEntry | undefined, cfg: BridgeServerConfig): entry is StoredEntry {
  if (!entry) return false;
  const a = originOf(entry.serverUrl);
  return a !== null && a === originOf(cfg.url);
}

const ownerKeyOf = (o: CredentialOwner): string =>
  JSON.stringify(o.kind === "account" ? ["account", o.accountId] : ["agent", o.tenant, o.persona]);

/** §4.2.4, one call. Throws BridgeRefused(403) for a token with no usable runAs
 *  (never defaulted to the agent, like the credential endpoint). */
export async function chooseCredential(
  claims: JobClaims,
  server: string,
  cfg: BridgeServerConfig,
  isPrivateServer: boolean,
  deps: CredentialDeps,
): Promise<BridgeCredential> {
  const runAs = parseRunAs(claims.runAs);
  if (!runAs) throw new BridgeRefused(403, "job token does not say whose identity this turn runs as");
  const key = oauthKey(server, { type: "http", url: cfg.url, headers: cfg.headers });
  const staticHeaders = { ...(cfg.headers ?? {}) };
  const oauth = (owner: CredentialOwner, entry: StoredEntry, url: string, base: Record<string, string>): BridgeCredential => ({
    kind: "oauth",
    owner,
    key,
    entry,
    url,
    headers: { ...withoutAuthorization(base), authorization: `Bearer ${entry.accessToken}` },
    ownerKey: ownerKeyOf(owner),
  });

  if (runAs.kind === "agent") {
    const owner: CredentialOwner = { kind: "agent", tenant: claims.tenant, persona: claims.persona || "default" };
    const entry = (await deps.credentialsFor(owner))[key];
    if (pinned(entry, cfg)) return oauth(owner, entry, cfg.url, staticHeaders);
    return { kind: "static", url: cfg.url, headers: staticHeaders, ownerKey: ownerKeyOf(owner) };
  }

  const account = await deps.accountFor(claims.team, runAs.slackUserId);
  const owner: CredentialOwner | null = account ? { kind: "account", accountId: account.id } : null;
  const entry = owner ? (await deps.credentialsFor(owner))[key] : undefined;
  if (isPrivateServer) {
    // The person's own grant or nothing. clearCredentials strips the static
    // headers and the URL's query, userinfo and fragment, exactly as the
    // private mount does in mono.
    if (!owner || !pinned(entry, cfg)) return { kind: "connect" };
    const cleared = clearCredentials(cfg as never) as unknown as BridgeServerConfig;
    return oauth(owner, entry, cleared.url, {});
  }
  if (owner && pinned(entry, cfg)) return oauth(owner, entry, cfg.url, staticHeaders);
  // Static headers are the config's (agent-wide), but the session is still
  // this person's: never pooled with the agent's or anyone else's.
  const who = owner ? ownerKeyOf(owner) : JSON.stringify(["user", claims.team, runAs.slackUserId]);
  return { kind: "static", url: cfg.url, headers: staticHeaders, ownerKey: who };
}

// ── upstream errors, classified in the fetch (the SDK's own errors embed bodies) ──

class UpstreamUnauthorized extends Error {
  constructor(readonly status: 401 | 403) {
    super(`upstream answered ${status}`);
    this.name = "UpstreamUnauthorized";
  }
}
class UpstreamSessionExpired extends Error {
  constructor() {
    super("upstream session expired");
    this.name = "UpstreamSessionExpired";
  }
}

/** A result schema that keeps everything: the bridge relays, it does not judge. */
const Loose = z.object({}).passthrough();

/** One JSON-RPC request, its result unvalidated beyond "an object" (the SDK's
 *  typed helpers would strip or validate what the bridge must pass through). */
const rawRequest = (
  client: Client,
  method: string,
  params: Record<string, unknown>,
  opts: { timeout: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> =>
  (client.request as unknown as (r: unknown, s: unknown, o: unknown) => Promise<Record<string, unknown>>).call(
    client,
    { method, params },
    Loose,
    opts,
  );

// ── limits ──────────────────────────────────────────────────────────────────

export interface BridgeLimits {
  timeoutMs: number;
  ownerConcurrency: number;
  maxRequestBytes: number;
  maxResultBytes: number;
}

export const envLimits = (): BridgeLimits => ({
  timeoutMs: env.mcpBridge.timeoutMs(),
  ownerConcurrency: env.mcpBridge.ownerConcurrency(),
  maxRequestBytes: env.mcpBridge.maxRequestBytes(),
  maxResultBytes: env.mcpBridge.maxResultBytes(),
});

/** Cap a result. Over the cap, text is kept up to the budget and everything
 *  else is dropped; dropping structuredContent marks the result an error so a
 *  client never validates a missing structured result against an outputSchema. */
export function capResult(result: CallToolResult, cap: number): CallToolResult {
  const size = Buffer.byteLength(JSON.stringify(result));
  if (size <= cap) return result;
  let budget = Math.max(0, cap - 512);
  const kept: { type: "text"; text: string }[] = [];
  for (const c of (result.content ?? []) as { type?: string; text?: unknown }[]) {
    if (budget <= 0) break;
    if (c?.type !== "text" || typeof c.text !== "string") continue;
    const bytes = Buffer.from(c.text);
    const take = bytes.subarray(0, budget).toString("utf8");
    kept.push({ type: "text", text: take });
    budget -= Math.min(bytes.length, budget);
  }
  kept.push({ type: "text", text: truncatedText(size, cap) });
  return { content: kept, isError: result.isError === true || result.structuredContent !== undefined };
}

// ── per-owner concurrency ───────────────────────────────────────────────────

/** Counting semaphores by key. A waiter whose call is aborted (before or
 *  while it waits) gives up its place at once and is never handed a slot. */
export class Slots {
  #active = new Map<string, number>();
  #waiting = new Map<string, Array<() => void>>();
  async acquire(key: string, limit: number, deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const n = this.#active.get(key) ?? 0;
    if (n < limit) {
      this.#active.set(key, n + 1);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const q = this.#waiting.get(key) ?? [];
      this.#waiting.set(key, q);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = q.indexOf(grant);
        if (i >= 0) q.splice(i, 1);
        resolve(ok);
      };
      // A released slot is handed over directly: the count stays as it was.
      const grant = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      q.push(grant);
    });
  }
  release(key: string): void {
    const next = this.#waiting.get(key)?.shift();
    if (next) return next();
    const n = (this.#active.get(key) ?? 1) - 1;
    if (n <= 0) this.#active.delete(key);
    else this.#active.set(key, n);
  }
  /** TEST SEAM. */
  active(key: string): number {
    return this.#active.get(key) ?? 0;
  }
}

// ── the bridge ──────────────────────────────────────────────────────────────

export type CredentialRefresher = Pick<ReturnType<typeof makeCredentialRefresher>, "refresh">;

export interface McpBridgeDeps {
  /** The persona's servers, resolved as its sessions resolve them. */
  servers(claims: JobClaims): ExternalMcp;
  accountFor?: CredentialDeps["accountFor"];
  credentialsFor?: CredentialDeps["credentialsFor"];
  refresher?: CredentialRefresher;
  /** Outbound policy options (tests admit loopback); default: the environment's. */
  policy?: OutboundPolicyOptions;
  limits?: () => BridgeLimits;
  /** Post the connect card in the claims' thread (rate-limited here). */
  onNeedsAuth?(claims: JobClaims, server: string, scope: "initiator" | "global", reason: "connect" | "reauth"): Promise<void> | void;
  /** How long one (session, server) waits between connect cards. Default 10 min. */
  cardWindowMs?: number;
  /** Most pooled upstream sessions kept open. Default 256. */
  maxPooled?: number;
  now?: () => number;
}

interface Pooled {
  /** Resolves once the upstream session is initialised. */
  client: Promise<Client>;
  /** The headers the next request carries; the bearer is swapped on refresh. */
  holder: { headers: Record<string, string> };
  lastUsed: number;
}

export interface McpBridge {
  list(claims: JobClaims, server: string, signal?: AbortSignal): Promise<ListOutcome>;
  call(claims: JobClaims, server: string, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
  limits(): BridgeLimits;
  close(): Promise<void>;
  /** TEST SEAM: pooled session keys. */
  __poolKeys(): string[];
}

const errResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createMcpBridge(deps: McpBridgeDeps): McpBridge {
  const credDeps: CredentialDeps = {
    accountFor: deps.accountFor ?? accountForSlackUser,
    credentialsFor: deps.credentialsFor ?? credentialsForDefault,
  };
  const refresher = (): CredentialRefresher => deps.refresher ?? defaultCredentialRefresher();
  const limits = deps.limits ?? envLimits;
  const now = deps.now ?? Date.now;
  const cardWindowMs = deps.cardWindowMs ?? 10 * 60_000;
  const maxPooled = deps.maxPooled ?? 256;
  const pool = new Map<string, Pooled>();
  const slots = new Slots();
  const lastCard = new Map<string, number>();
  /** The signal of the call a transport request belongs to. */
  const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  function resolveServer(claims: JobClaims, server: string): { cfg: BridgeServerConfig; isPrivate: boolean } {
    const mcp = deps.servers(claims);
    const cfg = oauthHttpServers(mcp.servers)[server] as BridgeServerConfig | undefined;
    if (!cfg) throw new BridgeRefused(404, NOT_MOUNTED);
    const timeout = (mcp.servers[server] as { timeout?: unknown }).timeout;
    if (typeof timeout === "number" && timeout > 0) cfg.timeout = timeout;
    const runAs = parseRunAs(claims.runAs);
    return { cfg, isPrivate: runAs?.kind === "user" && mcp.privateServices.includes(server) };
  }

  function maybeCard(claims: JobClaims, server: string, reason: "connect" | "reauth"): void {
    if (!deps.onNeedsAuth) return;
    const k = `${claims.session}\u0000${server}`;
    const last = lastCard.get(k);
    if (last !== undefined && now() - last < cardWindowMs) return;
    lastCard.set(k, now());
    const scope = parseRunAs(claims.runAs)?.kind === "user" ? "initiator" : "global";
    void Promise.resolve()
      .then(() => deps.onNeedsAuth!(claims, server, scope, reason))
      .catch((e) => console.warn(`[mcp-bridge] connect card failed server=${server} error=${e instanceof Error ? e.name : typeof e}`));
  }

  function makeFetch(origin: string, holder: { headers: Record<string, string> }) {
    const inner = policyFetch({ ...(deps.policy ?? {}), pinnedOrigin: origin, maxResponseBytes: Math.max(limits().maxResultBytes * 4, 4 * 1024 * 1024), timeoutMs: limits().timeoutMs + 5_000 });
    return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      // Notifications are not bridged: never open the standalone SSE stream.
      if ((init.method ?? "GET").toUpperCase() === "GET") return new Response(null, { status: 405 });
      const headers = new Headers(init.headers ?? undefined);
      for (const k of [...headers.keys()]) if (k === "authorization") headers.delete(k);
      for (const [k, v] of Object.entries(holder.headers)) headers.set(k, v);
      // A request (not a notification) is tied to its call's signal, so an
      // aborted call drops the upstream connection as well as sending
      // notifications/cancelled.
      let signal = init.signal ?? undefined;
      const call = callSignal.getStore();
      if (call && typeof init.body === "string" && /"id"\s*:/.test(init.body) && /"method"\s*:/.test(init.body)) {
        signal = signal ? AbortSignal.any([signal, call]) : call;
      }
      const res = await inner(input, { ...init, headers, ...(signal ? { signal } : {}) });
      if (res.status === 401 || res.status === 403) throw new UpstreamUnauthorized(res.status);
      if (res.status === 404 && headers.has("mcp-session-id")) throw new UpstreamSessionExpired();
      return res;
    };
  }

  /** Keep the pool bounded: close the least recently used session. */
  function evictIdle(): void {
    if (pool.size < maxPooled) return;
    let oldest: [string, number] | null = null;
    for (const [k, p] of pool) if (!oldest || p.lastUsed < oldest[1]) oldest = [k, p.lastUsed];
    if (oldest) drop(oldest[0]);
  }

  function drop(key: string): void {
    const p = pool.get(key);
    pool.delete(key);
    void p?.client.then((c) => c.close()).catch(() => {});
  }

  /** The pooled upstream session for `key`, opened on first use. The headers
   *  are this call's: a refreshed token replaces the bearer in place. */
  async function session(key: string, cred: Exclude<BridgeCredential, { kind: "connect" }>, timeoutMs: number): Promise<Client> {
    let p = pool.get(key);
    if (p) {
      p.holder.headers = cred.headers;
      p.lastUsed = now();
    } else {
      evictIdle();
      const holder = { headers: cred.headers };
      const origin = originOf(cred.url);
      const client = (async () => {
        if (!origin) throw new OutboundBlockedError("invalid URL");
        const transport = new StreamableHTTPClientTransport(new URL(cred.url), { fetch: makeFetch(origin, holder) as typeof fetch });
        const c = new Client({ name: "slaude-mcp-bridge", version: "1.0.0" });
        await c.connect(transport, { timeout: timeoutMs });
        return c;
      })();
      p = { client, holder, lastUsed: now() };
      pool.set(key, p);
    }
    const mine = p;
    try {
      return await mine.client;
    } catch (e) {
      if (pool.get(key) === mine) pool.delete(key);
      throw e;
    }
  }

  const poolKey = (cred: Exclude<BridgeCredential, { kind: "connect" }>, server: string) =>
    JSON.stringify([
      cred.ownerKey,
      server,
      createHash("sha256").update(JSON.stringify({ url: cred.url, headers: withoutAuthorization(cred.headers) })).digest("hex"),
    ]);

  /**
   * Run `op` against the upstream for this call's credential: one retry after a
   * refreshed OAuth token (401), one after an expired upstream session. Any
   * other failure maps to a fixed text.
   */
  async function run<T>(
    claims: JobClaims,
    server: string,
    cred: Exclude<BridgeCredential, { kind: "connect" }>,
    timeoutMs: number,
    left: () => number,
    signal: AbortSignal | undefined,
    op: (c: Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
    const key = poolKey(cred, server);
    let refreshed = false;
    let reconnected = false;
    let current = cred;
    for (;;) {
      try {
        // Opening the session is not tied to this call's signal: other calls
        // may be waiting on the same initialisation.
        const client = await session(key, current, left());
        return { ok: true, value: await callSignal.run(signal, () => op(client)) };
      } catch (e) {
        if (e instanceof UpstreamSessionExpired && !reconnected) {
          reconnected = true;
          drop(key);
          continue;
        }
        if (e instanceof UpstreamUnauthorized) {
          drop(key);
          if (e.status === 401 && current.kind === "oauth" && !refreshed) {
            refreshed = true;
            let out;
            try {
              out = await refresher().refresh(current.owner, current.key, sha256Hex(current.entry.accessToken));
            } catch (re) {
              console.warn(`[mcp-bridge] refresh failed server=${server} owner=${current.owner.kind} error=${re instanceof Error ? re.name : typeof re}`);
              out = { ok: false as const, reason: "reconnect" as const };
            }
            if (out.ok) {
              current = {
                ...current,
                entry: out.entry,
                headers: { ...withoutAuthorization(current.headers), authorization: `Bearer ${out.entry.accessToken}` },
              };
              continue;
            }
          }
          maybeCard(claims, server, "reauth");
          return { ok: false, text: reauthText(server) };
        }
        return { ok: false, text: describeFailure(e, server, timeoutMs, signal) };
      }
    }
  }

  function describeFailure(e: unknown, server: string, timeoutMs: number, signal?: AbortSignal): string {
    if (signal?.aborted) return cancelledText(server);
    if (e instanceof OutboundBlockedError) return `${server}: ${e.message}`;
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) return timeoutText(server, timeoutMs);
      // A JSON-RPC error the upstream answered with (an unknown tool, invalid
      // arguments): the protocol's own message, as a direct connection shows it.
      if (e.code !== ErrorCode.ConnectionClosed) return `MCP error ${e.code}: ${String(e.message).slice(0, 500)}`;
    }
    console.warn(`[mcp-bridge] upstream failure server=${server} error=${e instanceof Error ? e.name : typeof e}`);
    return unavailableText(server);
  }

  async function withSlot<T>(ownerKey: string, deadline: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T | null> {
    const lim = limits();
    if (!(await slots.acquire(ownerKey, lim.ownerConcurrency, deadline, signal))) return null;
    try {
      // Granted, but the call was aborted meanwhile: give the slot back unused.
      if (signal?.aborted) return null;
      return await fn();
    } finally {
      slots.release(ownerKey);
    }
  }

  const effectiveTimeout = (cfg: BridgeServerConfig): number => {
    const ceiling = limits().timeoutMs;
    return cfg.timeout && cfg.timeout < ceiling ? cfg.timeout : ceiling;
  };

  return {
    limits,

    async list(claims, server, signal) {
      const { cfg, isPrivate } = resolveServer(claims, server);
      const cred = await chooseCredential(claims, server, cfg, isPrivate, credDeps);
      if (cred.kind === "connect") {
        maybeCard(claims, server, "connect");
        return { tools: [], instructions: connectText(server), unavailable: true };
      }
      // One deadline for the whole call: the wait for a slot, opening the
      // session, a refresh and its retry all fit inside it.
      const timeoutMs = effectiveTimeout(cfg);
      const deadline = now() + timeoutMs;
      const left = () => Math.max(1, deadline - now());
      const out = await withSlot(cred.ownerKey, deadline, signal, () =>
        run(claims, server, cred, timeoutMs, left, signal, async (client) => {
          const tools: unknown[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 50; page++) {
            const r = (await rawRequest(client, "tools/list", cursor ? { cursor } : {}, {
              timeout: left(),
              ...(signal ? { signal } : {}),
            })) as { tools?: unknown[]; nextCursor?: string };
            tools.push(...(r.tools ?? []));
            cursor = r.nextCursor;
            if (!cursor) break;
          }
          return { tools, instructions: client.getInstructions(), serverInfo: client.getServerVersion() };
        }),
      );
      if (out === null) return { tools: [], instructions: busyText(server), unavailable: true };
      if (!out.ok) return { tools: [], instructions: out.text, unavailable: true };
      const v = out.value;
      return {
        tools: v.tools,
        ...(v.instructions ? { instructions: v.instructions } : {}),
        ...(v.serverInfo ? { serverInfo: v.serverInfo as ListOutcome["serverInfo"] } : {}),
      };
    },

    async call(claims, server, name, args, signal) {
      const { cfg, isPrivate } = resolveServer(claims, server);
      const cred = await chooseCredential(claims, server, cfg, isPrivate, credDeps);
      if (cred.kind === "connect") {
        maybeCard(claims, server, "connect");
        return errResult(connectText(server));
      }
      const timeoutMs = effectiveTimeout(cfg);
      const deadline = now() + timeoutMs;
      const left = () => Math.max(1, deadline - now());
      const out = await withSlot(cred.ownerKey, deadline, signal, () =>
        run(claims, server, cred, timeoutMs, left, signal, (client) =>
          rawRequest(client, "tools/call", { name, arguments: args ?? {} }, {
            timeout: left(),
            ...(signal ? { signal } : {}),
          }) as Promise<CallToolResult>,
        ),
      );
      if (out === null) return errResult(signal?.aborted ? cancelledText(server) : busyText(server));
      if (!out.ok) return errResult(out.text);
      return capResult(out.value, limits().maxResultBytes);
    },

    async close() {
      const all = [...pool.keys()];
      for (const k of all) drop(k);
    },

    __poolKeys: () => [...pool.keys()],
  };
}
