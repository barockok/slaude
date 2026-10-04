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
import type { Redis } from "ioredis";
import { getRedis } from "../../queue/redis";
import { redisPrefix } from "../../queue/keys";

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
export const interruptedText = (server: string) =>
  `the call to ${server} was interrupted; it may have been executed — check before retrying`;
export const forbiddenText = (server: string) => `${server} refused this call: permission denied for this identity`;
export const listTruncatedText = (shown: number, maxTools: number, maxBytes: number) =>
  `[tool list truncated by the MCP bridge: ${shown} tools are available here; the limits are ${maxTools} tools and ${maxBytes} bytes]`;

/** A JSON-RPC error the upstream answered with, as FIXED text per class: its
 *  own message is never relayed (it can carry anything). */
export function protocolErrorText(server: string, code: unknown): string {
  switch (code) {
    case ErrorCode.MethodNotFound:
      return `${server} does not support this request`;
    case ErrorCode.InvalidParams:
      return `${server} rejected the call: unknown tool or invalid arguments`;
    case ErrorCode.InvalidRequest:
      return `${server} rejected the request as invalid`;
    case ErrorCode.InternalError:
      return `${server} reported an internal error`;
    default:
      return `${server} returned an error (code ${Number.isSafeInteger(code) ? code : "unknown"})`;
  }
}

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
      /** The CONFIG-supplied headers among `headers` (not the OAuth bearer). */
      configHeaders: Record<string, string>;
    }
  | { kind: "static"; url: string; headers: Record<string, string>; ownerKey: string; configHeaders: Record<string, string> }
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

/** Headers a server CONFIG may not set: transport framing, hop-by-hop headers
 *  and the MCP session id belong to the client. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection",
  "te", "trailer", "upgrade", "mcp-session-id", "mcp-protocol-version",
]);

export function configSuppliedHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (typeof v === "string" && !RESERVED_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

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
  const staticHeaders = configSuppliedHeaders(cfg.headers);
  const oauth = (owner: CredentialOwner, entry: StoredEntry, url: string, base: Record<string, string>): BridgeCredential => ({
    kind: "oauth",
    owner,
    key,
    entry,
    url,
    headers: { ...withoutAuthorization(base), authorization: `Bearer ${entry.accessToken}` },
    ownerKey: ownerKeyOf(owner),
    configHeaders: withoutAuthorization(base),
  });

  if (runAs.kind === "agent") {
    const owner: CredentialOwner = { kind: "agent", tenant: claims.tenant, persona: claims.persona || "default" };
    const entry = (await deps.credentialsFor(owner))[key];
    if (pinned(entry, cfg)) return oauth(owner, entry, cfg.url, staticHeaders);
    return { kind: "static", url: cfg.url, headers: staticHeaders, ownerKey: ownerKeyOf(owner), configHeaders: staticHeaders };
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
  return { kind: "static", url: cfg.url, headers: staticHeaders, ownerKey: who, configHeaders: staticHeaders };
}

// ── static-credential origin pins ───────────────────────────────────────────

/**
 * Where a server's CONFIG-supplied headers were first sent, per (tenant,
 * persona, server, headers). A server whose URL later moves to another origin
 * with the same headers is refused: the headers are a credential bound to the
 * host they were written for. Defence in depth on top of the managed-config
 * rule; OAuth entries carry their own pin (the entry's serverUrl).
 */
export interface OriginPins {
  /** Record `origin` if nothing is pinned yet; return the pinned origin. */
  pin(key: string, origin: string): Promise<string>;
}

export function localOriginPins(): OriginPins {
  const m = new Map<string, string>();
  return {
    async pin(key, origin) {
      if (!m.has(key)) m.set(key, origin);
      return m.get(key)!;
    },
  };
}

/** Shared by every gateway replica; no expiry. To move a server deliberately
 *  an operator deletes `<prefix>:mcpx-origin-pin:<id>` (the id is logged at the
 *  first refusal) or rotates the header values. */
export function redisOriginPins(redis: Redis, prefix: string): OriginPins {
  return {
    async pin(key, origin) {
      const k = `${prefix}:mcpx-origin-pin:${key}`;
      await redis.set(k, origin, "NX");
      return (await redis.get(k)) ?? origin;
    },
  };
}

export const pinnedElsewhereText = (server: string) =>
  `${server}: its configured credentials are pinned to the host they were first sent to, and the server's URL now points elsewhere; the gateway will not send them there`;

const pinKey = (claims: JobClaims, server: string, headers: Record<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify([claims.tenant, claims.persona || "default", server, Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))]))
    .digest("hex");

// ── upstream errors, classified in the fetch (the SDK's own errors embed bodies) ──

class UpstreamUnauthorized extends Error {
  constructor() {
    super("upstream answered 401");
    this.name = "UpstreamUnauthorized";
  }
}
/** 403: the identity is known but not permitted. Refreshing cannot help. */
class UpstreamForbidden extends Error {
  constructor() {
    super("upstream answered 403");
    this.name = "UpstreamForbidden";
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
  /** Calls in flight at once for one session on one server (within the owner's). */
  sessionConcurrency?: number;
  /** A pooled upstream session unused this long is closed and reopened. */
  idleMs?: number;
  /** Caps on one server's tool list: total bytes and number of tools. */
  maxListBytes?: number;
  maxTools?: number;
}

export const DEFAULT_SESSION_CONCURRENCY = 4;
export const DEFAULT_IDLE_MS = 5 * 60_000;
export const DEFAULT_MAX_LIST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_TOOLS = 500;

export const envLimits = (): BridgeLimits => ({
  timeoutMs: env.mcpBridge.timeoutMs(),
  ownerConcurrency: env.mcpBridge.ownerConcurrency(),
  maxRequestBytes: env.mcpBridge.maxRequestBytes(),
  maxResultBytes: env.mcpBridge.maxResultBytes(),
  sessionConcurrency: env.mcpBridge.sessionConcurrency(),
  idleMs: env.mcpBridge.idleMs(),
  maxListBytes: env.mcpBridge.maxListBytes(),
  maxTools: env.mcpBridge.maxTools(),
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
  /** Static-credential origin pins. Default: Redis in the gateway role, else in-process. */
  originPins?: OriginPins;
  now?: () => number;
}

interface Pooled {
  /** Resolves once the upstream session is initialised. */
  client: Promise<Client>;
  /** The headers the next request carries; the bearer is swapped on refresh. */
  holder: { headers: Record<string, string> };
  lastUsed: number;
  /** Calls currently using this session. */
  inflight: number;
  /** Out of service: no new call takes it; closed when `inflight` reaches 0. */
  stale: boolean;
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
  let pins: OriginPins | undefined = deps.originPins;
  const originPins = (): OriginPins =>
    (pins ??= env.role() === "gateway" ? redisOriginPins(getRedis(), redisPrefix()) : localOriginPins());
  /** The config headers may go to this origin only if they went there first. */
  const loggedPins = new Set<string>();
  async function pinRefused(claims: JobClaims, server: string, cred: Exclude<BridgeCredential, { kind: "connect" }>): Promise<boolean> {
    if (Object.keys(cred.configHeaders).length === 0) return false;
    const origin = originOf(cred.url);
    if (!origin) return true;
    const id = pinKey(claims, server, cred.configHeaders);
    const pinnedTo = await originPins().pin(id, origin);
    if (pinnedTo === origin) return false;
    // The id is a hash of (tenant, persona, server, headers), never a secret:
    // the operator deletes `<SLAUDE_REDIS_PREFIX>:mcpx-origin-pin:<id>` to move
    // the server deliberately (docs/site/_content/deploy/mcp-bridge.md).
    if (!loggedPins.has(id)) {
      if (loggedPins.size >= 1000) loggedPins.clear();
      loggedPins.add(id);
      console.warn(`[mcp-bridge] refused: configured credentials of server=${server} are pinned to another origin; pin id=${id}`);
    }
    return true;
  }
  const cardWindowMs = deps.cardWindowMs ?? 10 * 60_000;
  const maxPooled = deps.maxPooled ?? 256;
  const pool = new Map<string, Pooled>();
  const slots = new Slots();
  const lastCard = new Map<string, number>();
  /** The signal of the call a transport request belongs to. */
  const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  function resolveServer(claims: JobClaims, server: string): { cfg: BridgeServerConfig; isPrivate: boolean } {
    const mcp = deps.servers(claims);
    const http = oauthHttpServers(mcp.servers);
    // Own properties only: "constructor", "toString" or "__proto__" are not servers.
    if (!Object.hasOwn(http, server) || !Object.hasOwn(mcp.servers, server)) throw new BridgeRefused(404, NOT_MOUNTED);
    const cfg = http[server] as BridgeServerConfig;
    const timeout = (mcp.servers[server] as { timeout?: unknown }).timeout;
    if (typeof timeout === "number" && timeout > 0) cfg.timeout = timeout;
    const runAs = parseRunAs(claims.runAs);
    return { cfg, isPrivate: runAs?.kind === "user" && mcp.privateServices.includes(server) };
  }

  /** Who could click a connect card for this turn, if anyone: the card's click
   *  handler wants the runAs user still holding the thread's /1on1 lock
   *  (initiator), or no lock at all (global, the manager). A cron turn with a
   *  captured initiator and no live lock gets no card: nobody could use it. */
  function cardScope(claims: JobClaims): "initiator" | "global" | null {
    const runAs = parseRunAs(claims.runAs);
    if (runAs?.kind === "user") {
      if (claims.lock === undefined) return "initiator"; // an older gateway's token: unknown, try
      return claims.lock?.user === runAs.slackUserId ? "initiator" : null;
    }
    return claims.lock ? null : "global";
  }

  const MAX_CARD_KEYS = 1000;
  function maybeCard(claims: JobClaims, server: string, reason: "connect" | "reauth"): void {
    if (!deps.onNeedsAuth) return;
    const scope = cardScope(claims);
    if (!scope) return;
    const k = `${claims.session}\u0000${server}`;
    const t = now();
    const last = lastCard.get(k);
    if (last !== undefined && t - last < cardWindowMs) return;
    lastCard.delete(k);
    lastCard.set(k, t);
    // Bounded: expired entries first, then the oldest (Map keeps insertion order).
    if (lastCard.size > MAX_CARD_KEYS) {
      for (const [key, at] of lastCard) if (t - at >= cardWindowMs) lastCard.delete(key);
      for (const key of lastCard.keys()) {
        if (lastCard.size <= MAX_CARD_KEYS) break;
        lastCard.delete(key);
      }
    }
    void Promise.resolve()
      .then(() => deps.onNeedsAuth!(claims, server, scope, reason))
      .catch((e) => console.warn(`[mcp-bridge] connect card failed server=${server} error=${e instanceof Error ? e.name : typeof e}`));
  }

  function makeFetch(origin: string, holder: { headers: Record<string, string> }) {
    const lim = limits();
    const inner = policyFetch({
      ...(deps.policy ?? {}),
      pinnedOrigin: origin,
      maxResponseBytes: Math.max(lim.maxResultBytes * 4, lim.maxListBytes ?? DEFAULT_MAX_LIST_BYTES, 1024 * 1024),
      timeoutMs: lim.timeoutMs + 5_000,
    });
    return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      // Notifications are not bridged: never open the standalone SSE stream.
      if ((init.method ?? "GET").toUpperCase() === "GET") return new Response(null, { status: 405 });
      const headers = new Headers(init.headers ?? undefined);
      for (const k of [...headers.keys()]) if (k === "authorization") headers.delete(k);
      for (const [k, v] of Object.entries(holder.headers)) headers.set(k, v);
      // A request (not a notification) is tied to its call's own controller:
      // aborting the call, its deadline, or its completion closes the
      // connection, so a stream the upstream holds open never keeps the socket.
      let signal = init.signal ?? undefined;
      const call = callSignal.getStore();
      if (call && typeof init.body === "string" && /"id"\s*:/.test(init.body) && /"method"\s*:/.test(init.body)) {
        signal = signal ? AbortSignal.any([signal, call]) : call;
      }
      const res = await inner(input, { ...init, headers, ...(signal ? { signal } : {}) });
      const fail = async (e: Error): Promise<never> => {
        await res.body?.cancel().catch(() => {});
        throw e;
      };
      if (res.status === 401) return fail(new UpstreamUnauthorized());
      if (res.status === 403) return fail(new UpstreamForbidden());
      // Servers answer a session they no longer know with 404 (the spec) or 400.
      if ((res.status === 404 || res.status === 400) && headers.has("mcp-session-id")) return fail(new UpstreamSessionExpired());
      return res;
    };
  }

  /** Keep the pool bounded and fresh: retire sessions idle past the expiry,
   *  and the least recently used idle one when full. A session with calls in
   *  flight is never closed under them (retire only marks it stale). */
  function sweep(keep: string): void {
    const idleMs = limits().idleMs ?? DEFAULT_IDLE_MS;
    const t = now();
    for (const [k, p] of pool) if (k !== keep && p.inflight === 0 && t - p.lastUsed > idleMs) retire(k, p);
    if (pool.size < maxPooled) return;
    let oldest: [string, Pooled] | null = null;
    for (const [k, p] of pool) if (k !== keep && p.inflight === 0 && (!oldest || p.lastUsed < oldest[1].lastUsed)) oldest = [k, p];
    if (oldest) retire(oldest[0], oldest[1]);
  }

  function closeSession(p: Pooled): void {
    void p.client.then((c) => c.close()).catch(() => {});
  }

  /** Take THIS session out of service: new calls open a fresh one; it closes
   *  when its last in-flight call finishes. A session that already replaced it
   *  under the same key is left alone. */
  function retire(key: string, p: Pooled): void {
    if (pool.get(key) === p) pool.delete(key);
    if (p.stale) return;
    p.stale = true;
    if (p.inflight === 0) closeSession(p);
  }

  /** Lease the pooled session for `key` (opened on first use, after it went
   *  stale, or after it sat idle past the expiry). Synchronous get-or-create, so
   *  N concurrent callers share ONE new session (single flight). The headers are
   *  this call's: a refreshed token replaces the bearer in place. */
  function lease(key: string, cred: Exclude<BridgeCredential, { kind: "connect" }>, timeoutMs: number): Pooled {
    let p = pool.get(key);
    if (p && p.inflight === 0 && now() - p.lastUsed > (limits().idleMs ?? DEFAULT_IDLE_MS)) {
      retire(key, p);
      p = undefined;
    }
    sweep(key);
    if (p) {
      p.holder.headers = cred.headers;
    } else {
      const holder = { headers: cred.headers };
      const origin = originOf(cred.url);
      const client = (async () => {
        if (!origin) throw new OutboundBlockedError("invalid URL");
        const transport = new StreamableHTTPClientTransport(new URL(cred.url), { fetch: makeFetch(origin, holder) as typeof fetch });
        const c = new Client({ name: "slaude-mcp-bridge", version: "1.0.0" });
        // The initialize request gets its own controller, closed once the
        // session is open: an answer stream the upstream holds open must not
        // keep the socket.
        const opening = new AbortController();
        try {
          await callSignal.run(opening.signal, () => c.connect(transport, { timeout: timeoutMs }));
        } finally {
          opening.abort();
        }
        return c;
      })();
      // Observed here so a failed open is never an unhandled rejection.
      client.catch(() => {});
      p = { client, holder, lastUsed: now(), inflight: 0, stale: false };
      pool.set(key, p);
    }
    p.lastUsed = now();
    p.inflight++;
    return p;
  }

  function unlease(p: Pooled): void {
    p.inflight--;
    p.lastUsed = now();
    if (p.stale && p.inflight === 0) closeSession(p);
  }

  const poolKey = (cred: Exclude<BridgeCredential, { kind: "connect" }>, server: string) =>
    JSON.stringify([
      cred.ownerKey,
      server,
      createHash("sha256").update(JSON.stringify({ url: cred.url, headers: withoutAuthorization(cred.headers) })).digest("hex"),
    ]);

  /** A failure a fresh upstream session may cure: not the upstream's own
   *  protocol answer, not a timeout or cancellation, not a policy refusal. */
  function retriable(e: unknown, signal: AbortSignal | undefined, callSig: AbortSignal): boolean {
    if (signal?.aborted || callSig.aborted) return false;
    if (e instanceof UpstreamSessionExpired) return true;
    if (e instanceof OutboundBlockedError || e instanceof UpstreamUnauthorized || e instanceof UpstreamForbidden) return false;
    if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed;
    return true;
  }

  /**
   * Run `op` against the upstream for this call's credential. A 401 refreshes
   * the OAuth token once and retries once. A failure a fresh session may cure
   * retries once on a fresh session, except for a tools/call that reached the
   * upstream: calls are at most once (only a stale-session rejection, which
   * the server sends before running anything, is retried). Only the session
   * that failed is retired, and never under other calls still using it.
   */
  async function run<T>(
    claims: JobClaims,
    server: string,
    cred: Exclude<BridgeCredential, { kind: "connect" }>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callSig: AbortSignal,
    /** Safe to repeat (tools/list). A tools/call is NOT: it is retried only
     *  when the upstream provably did not run it (a stale-session rejection). */
    idempotent: boolean,
    op: (c: Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
    const key = poolKey(cred, server);
    let refreshed = false;
    let reconnected = false;
    let current = cred;
    for (;;) {
      // Whether the failure came from the request itself (the upstream may have
      // acted on it) or from opening the session (it never saw the request).
      let sent = false;
      // Opening the session is not tied to this call's signal or budget:
      // other calls may be waiting on the same initialisation, so it gets the
      // full configured timeout and each caller waits only its own deadline.
      const p = lease(key, current, timeoutMs);
      try {
        const client = await p.client;
        sent = true;
        return { ok: true, value: await callSignal.run(callSig, () => op(client)) };
      } catch (e) {
        if (!sent) retire(key, p); // the open failed: nobody can use it
        if (e instanceof UpstreamForbidden) return { ok: false, text: forbiddenText(server) };
        if (e instanceof UpstreamUnauthorized) {
          retire(key, p);
          if (current.kind === "oauth" && !refreshed) {
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
        if (e instanceof UpstreamSessionExpired) retire(key, p);
        // At most once: a call that reached the upstream and then failed in
        // transit (a 5xx, a dropped connection, a stream that ended or went
        // silent until the deadline) may have run. Only a stale session, which
        // the server rejects before running anything, is safe to repeat. The
        // session is retired (an upstream that forgot it may answer every
        // request with a 5xx), but closes only once other calls on it finish.
        if (sent && !idempotent && !(e instanceof UpstreamSessionExpired) && !signal?.aborted && mayHaveRun(e, callSig)) {
          retire(key, p);
          console.warn(`[mcp-bridge] call interrupted server=${server} error=${e instanceof Error ? e.name : typeof e}`);
          return { ok: false, text: interruptedText(server) };
        }
        if (!reconnected && retriable(e, signal, callSig)) {
          reconnected = true;
          if (sent) retire(key, p);
          continue;
        }
        return { ok: false, text: describeFailure(e, server, timeoutMs, signal, callSig) };
      } finally {
        unlease(p);
      }
    }
  }

  /** After the request was sent: a transport failure, or no answer by the
   *  deadline, leaves the call's outcome unknown. A JSON-RPC error answer, a
   *  policy refusal or an auth answer does not. */
  function mayHaveRun(e: unknown, callSig: AbortSignal): boolean {
    if (callSig.aborted) return true;
    if (e instanceof OutboundBlockedError || e instanceof UpstreamUnauthorized || e instanceof UpstreamForbidden) return false;
    if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed || e.code === ErrorCode.RequestTimeout;
    return true;
  }

  function describeFailure(e: unknown, server: string, timeoutMs: number, signal: AbortSignal | undefined, callSig: AbortSignal): string {
    if (signal?.aborted) return cancelledText(server);
    if (callSig.aborted) return timeoutText(server, timeoutMs);
    if (e instanceof OutboundBlockedError) return `${server}: ${e.message}`;
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) return timeoutText(server, timeoutMs);
      if (e.code !== ErrorCode.ConnectionClosed) return protocolErrorText(server, e.code);
    }
    console.warn(`[mcp-bridge] upstream failure server=${server} error=${e instanceof Error ? e.name : typeof e}`);
    return unavailableText(server);
  }

  /** Two slots per call: one for this session on this server (so one thread's
   *  slow calls cannot starve the persona's other threads), one for the owner
   *  on this server (so one identity cannot exhaust the gateway's sockets). */
  async function withSlots<T>(
    claims: JobClaims,
    server: string,
    ownerKey: string,
    deadline: number,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const lim = limits();
    const sessionKey = JSON.stringify(["session", ownerKey, server, claims.session]);
    const ownerSlotKey = JSON.stringify(["owner", ownerKey, server]);
    if (!(await slots.acquire(sessionKey, lim.sessionConcurrency ?? DEFAULT_SESSION_CONCURRENCY, deadline, signal))) return null;
    try {
      if (!(await slots.acquire(ownerSlotKey, lim.ownerConcurrency, deadline, signal))) return null;
      try {
        // Granted, but the call was aborted meanwhile: give the slots back unused.
        if (signal?.aborted) return null;
        return await fn();
      } finally {
        slots.release(ownerSlotKey);
      }
    } finally {
      slots.release(sessionKey);
    }
  }

  const effectiveTimeout = (cfg: BridgeServerConfig): number => {
    const ceiling = limits().timeoutMs;
    return cfg.timeout && cfg.timeout < ceiling ? cfg.timeout : ceiling;
  };

  /** One call's budget: a single deadline across the slot wait, opening the
   *  session, a refresh and its retry; and its own controller, aborted by the
   *  caller's signal, by the deadline, and when the call is over. */
  async function budgeted<T>(
    cfg: BridgeServerConfig,
    signal: AbortSignal | undefined,
    fn: (b: { timeoutMs: number; deadline: number; left: () => number; callSig: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = effectiveTimeout(cfg);
    const deadline = now() + timeoutMs;
    const left = () => Math.max(1, deadline - now());
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fn({ timeoutMs, deadline, left, callSig: ac.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ac.abort();
    }
  }

  return {
    limits,

    async list(claims, server, signal) {
      const { cfg, isPrivate } = resolveServer(claims, server);
      const cred = await chooseCredential(claims, server, cfg, isPrivate, credDeps);
      if (cred.kind === "connect") {
        maybeCard(claims, server, "connect");
        return { tools: [], instructions: connectText(server), unavailable: true };
      }
      if (await pinRefused(claims, server, cred)) return { tools: [], instructions: pinnedElsewhereText(server), unavailable: true };
      const lim = limits();
      const maxTools = lim.maxTools ?? DEFAULT_MAX_TOOLS;
      const maxBytes = lim.maxListBytes ?? DEFAULT_MAX_LIST_BYTES;
      const out = await budgeted(cfg, signal, ({ timeoutMs, deadline, left, callSig }) =>
        withSlots(claims, server, cred.ownerKey, deadline, signal, () =>
          run(claims, server, cred, timeoutMs, signal, callSig, true, async (client) => {
            const tools: unknown[] = [];
            let bytes = 0;
            let truncated = false;
            let cursor: string | undefined;
            for (let page = 0; page < 50 && !truncated; page++) {
              const r = (await rawRequest(client, "tools/list", cursor ? { cursor } : {}, {
                timeout: left(),
                ...(signal ? { signal } : {}),
              })) as { tools?: unknown[]; nextCursor?: string };
              for (const t of Array.isArray(r.tools) ? r.tools : []) {
                const size = Buffer.byteLength(JSON.stringify(t));
                if (tools.length >= maxTools || bytes + size > maxBytes) {
                  truncated = true;
                  break;
                }
                tools.push(t);
                bytes += size;
              }
              cursor = r.nextCursor;
              if (!cursor) break;
            }
            return { tools, truncated, instructions: client.getInstructions(), serverInfo: client.getServerVersion() };
          }),
        ),
      );
      if (out === null) return { tools: [], instructions: signal?.aborted ? cancelledText(server) : busyText(server), unavailable: true };
      if (!out.ok) return { tools: [], instructions: out.text, unavailable: true };
      const v = out.value;
      const notice = v.truncated ? listTruncatedText(v.tools.length, maxTools, maxBytes) : "";
      const instructions = [v.instructions, notice].filter(Boolean).join("\n\n");
      return {
        tools: v.tools,
        ...(instructions ? { instructions } : {}),
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
      if (await pinRefused(claims, server, cred)) return errResult(pinnedElsewhereText(server));
      const out = await budgeted(cfg, signal, ({ timeoutMs, deadline, left, callSig }) =>
        withSlots(claims, server, cred.ownerKey, deadline, signal, () =>
          run(claims, server, cred, timeoutMs, signal, callSig, false, (client) =>
            rawRequest(client, "tools/call", { name, arguments: args ?? {} }, {
              timeout: left(),
              ...(signal ? { signal } : {}),
            }) as Promise<CallToolResult>,
          ),
        ),
      );
      if (out === null) return errResult(signal?.aborted ? cancelledText(server) : busyText(server));
      if (!out.ok) return errResult(out.text);
      return capResult(out.value, limits().maxResultBytes);
    },

    async close() {
      const all = [...pool.keys()];
      for (const k of all) {
        const p = pool.get(k)!;
        pool.delete(k);
        closeSession(p);
      }
    },

    __poolKeys: () => [...pool.keys()],
  };
}
