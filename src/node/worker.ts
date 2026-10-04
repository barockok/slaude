/**
 * Node worker (spec §6): one BullMQ worker per label this node's credential
 * carries (`turns` for `default`, `turns.label.<label>` otherwise) plus one on
 * this node's per-node queue, running SDK turns through the existing AgentManager
 * with every gateway dependency swapped for its REST/queue counterpart:
 *
 *   sessions    → RestSessionStore over /v1/sessions
 *   MCP tools   → contract shims POSTing /v1/tools/<server>/<tool>
 *   permissions → shared policy + runtime/can_use_tool + /v1/pending long-poll
 *   child env   → tenant runtime bundle creds (ETag-cached), not process env
 *   events      → appended to the events:<session> Redis stream
 *
 * Per job: a job whose label this node does not carry is moved to its label's
 * queue (never re-queued here); consume the durable abort flag (a pre-claim
 * /abort skips the turn),
 * take lock:session:<id> (held elsewhere → delay + requeue, never bounce),
 * run the turn, then keep the Query warm — registered in sess:<id> with
 * heartbeats — until the idle TTL closes it. Losing the lock mid-turn or an
 * abort publish aborts the agent. SIGTERM drains: stop claiming, finish
 * in-flight turns within the grace, deregister everything, exit.
 */
import { hostname, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Worker, DelayedError, UnrecoverableError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { AgentManager, type AgentEvent } from "../agent/manager";
import { createSessionMcp, SESSION_MCP_NAME } from "../agent/session-mcp";
import { env } from "../config/env";
import { m as metric, metrics } from "../metrics";
import { assertNodeIdUsable, DEFAULT_LABEL, LABEL_RE, labelTurnsQueue, makeKeys, nodeTurnsQueue, type Keys } from "../queue/keys";
import { createRedis, heartbeatSec as envHeartbeatSec, nodeDrainSec, redisUrl } from "../queue/redis";
import { makeRegistry, type Registry } from "../queue/registry";
import { makePubSub, type PubSub } from "../queue/pubsub";
import { withSessionLock, HELD_BY_OTHER } from "../queue/locks";
import { jobLabel, TurnQueues, type TurnJob } from "../queue/turns";
import { GateDenied, isLabelMismatch, labelMismatchBoot, NodeApiError, NodeClient, bundleFetchFailure } from "./client";
import { makeAuthRecovery, makeSessionSeeder } from "./credentials";
import { nodeConfigRoot, sessionConfigDir, existingSessionConfigDir } from "../agent/config-root";
import { RestSessionStore } from "./session-store";
import { buildShimServers } from "./shims";
import { buildBridgeServers } from "./bridge";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { makeNodeMemoryProvider } from "./memory";
import { makeNodePermissionResolver } from "./shims/permission";
import { JOB_TOKEN_TTL_SEC } from "../gateway/api/auth";
import type { RuntimeBundle } from "../gateway/api/tenants";
import { decodeClaims, makeRemoteFactory, makeRemoteResolver } from "./remote";
import { lockFromClaims } from "./session-lock";
import { type NodeManifest, loadNodeManifest, makeNodeLocalMcpResolver } from "./manifest";
import { ChildEnvPatch } from "../agent/child-env";
import { BootFailure, createOnceGuard, type FailureCode } from "../gateway/core/failure-codes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Locked-turn result: the warm session is not on this job's config yet. */
export const STALE_CONFIG = Symbol("stale-config");

/**
 * The part of a claim that runs under lock:session:<id>: bind this job's token,
 * reboot a warm session whose config it no longer matches, then run the turn.
 * The token is bound only by the lock holder: a boot resolves its remote target,
 * child env and credentials from the bound token, so a job that is about to lose
 * the lock race must not swap the token under the holder's boot (it would boot
 * one config labelled with another's fingerprint).
 */
export async function runLockedTurn<T>(deps: {
  lock: (fn: (lostLock: AbortSignal) => Promise<T | typeof STALE_CONFIG>) => Promise<T | typeof STALE_CONFIG | typeof HELD_BY_OTHER>;
  bindToken: (jobToken: string) => void;
  ensureConfigFp: (fp: string | undefined) => Promise<boolean>;
  jobToken: string;
  run: (lostLock: AbortSignal) => Promise<T>;
}): Promise<T | typeof STALE_CONFIG | typeof HELD_BY_OTHER> {
  return deps.lock(async (lostLock) => {
    deps.bindToken(deps.jobToken);
    // A changed lock/remote config reboots the warm session before this turn
    // is sent; an older gateway mints no fingerprint and the manager ignores
    // it. Checked under the lock so no other job's turn, reboot or token lands
    // between the check and the send. Not current (a turn or a boot is still
    // in flight) → never send into the stale session, whose tools may be local
    // while the thread is remote: the caller requeues like a held lock.
    if (!(await deps.ensureConfigFp(decodeClaims(deps.jobToken)?.sessionConfigFp))) return STALE_CONFIG;
    return deps.run(lostLock);
  });
}

/** Fraction of a job token's lifetime already spent (0..∞; >1 = expired).
 *  Pure payload parse — the gateway is the verifier; the node only decides
 *  WHEN to ask for a refresh. null when the token is unparseable. */
export function tokenAgeFraction(token: string, nowMs: number = Date.now()): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const { iat, exp } = payload as { iat?: number; exp?: number };
    if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat) return null;
    return (nowMs / 1000 - iat) / (exp - iat);
  } catch {
    return null;
  }
}

export { decodeClaims };

/**
 * The token a claimed job runs on. Refresh an aging token at claim: it was
 * minted at ENQUEUE, but the turn's deadline starts NOW, so a job that sat in
 * the queue would otherwise run on a mostly-spent (or expired, within the
 * refresh grace) token. A refresh refused with 401 means the job waited past
 * the grace: ask the gateway to re-mint it from the queued job (node labels
 * spec §4.4). A refusal of either because the persona now runs on another
 * label (409 LABEL_MISMATCH), or a gate 403, throws BootFailure("LABEL_MISMATCH"): the
 * job fails and the gateway re-dispatches it once. Any other failure keeps
 * the original token.
 */
export async function tokenAtClaim(
  client: Pick<NodeClient, "refreshJobToken" | "reissueJobToken">,
  jobId: string,
  queueName: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const age = tokenAgeFraction(token, nowMs);
  if (age === null || age <= 0.2) return token;
  try {
    return await client.refreshJobToken(jobId, token);
  } catch (e) {
    if (e instanceof GateDenied || (e instanceof NodeApiError && isLabelMismatch(e.status, e.body))) {
      throw new BootFailure("LABEL_MISMATCH", `token refresh refused for job ${jobId}: the agent's label changed`, { cause: e });
    }
    if (e instanceof NodeApiError && e.status === 401) {
      try {
        return await client.reissueJobToken(jobId, queueName, token);
      } catch (e2) {
        if (e2 instanceof GateDenied || (e2 instanceof NodeApiError && isLabelMismatch(e2.status, e2.body))) {
          throw new BootFailure("LABEL_MISMATCH", `token reissue refused for job ${jobId}: the agent's label changed`, { cause: e2 });
        }
        console.warn(`[node] token reissue failed job=${jobId} (continuing with the original):`, e2);
      }
    } else {
      console.warn(`[node] token refresh failed job=${jobId} (continuing with the original):`, e);
    }
    return token;
  }
}

/**
 * The node's response to a tenant's reload signal. Busting the runtime-bundle
 * cache alone changes nothing for a warm session: the soul is baked into the
 * system prompt at session boot. So every session of the signalled tenant is
 * also reloaded through AgentManager.reloadAfterTurn, which decides whether a
 * turn is in flight: an idle session reloads now, a busy one when its turn's
 * result arrives (closing input mid-turn would end the CLI's stdin under it).
 * Either way the next turn boots fresh. Only the signalled tenant is touched.
 */
export function makeTenantReloadHandler(deps: {
  bustRuntime: (tenantId: string) => void;
  reload: (sessionId: string) => boolean;
  tenants: ReadonlyMap<string, string>;
}): (tenantId: string) => void {
  return (tenantId) => {
    deps.bustRuntime(tenantId);
    for (const [sid, t] of deps.tenants) if (t === tenantId) deps.reload(sid);
  };
}

/**
 * The child-env overlay a runtime bundle yields: provider credentials, and for
 * a named persona its Slack user id as SLAUDE_AGENT_ID, the anchor of its
 * private brain slice (plugin-spawned MCP subprocesses inherit the child env).
 * The default persona gets none, exactly as the registry path behaves.
 */
export function bundleChildEnv(
  bundle: Pick<RuntimeBundle, "providerCreds" | "slackUserId">,
  persona: string,
): Record<string, string | undefined> {
  const creds = bundle.providerCreds ?? {};
  const out: Record<string, string | undefined> = {};
  if (creds.apiKey) out.ANTHROPIC_API_KEY = creds.apiKey;
  if (creds.baseUrl) out.ANTHROPIC_BASE_URL = creds.baseUrl;
  if (creds.authToken) out.ANTHROPIC_AUTH_TOKEN = creds.authToken;
  if (creds.oauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = creds.oauthToken;
  if (persona !== "default" && bundle.slackUserId) out.SLAUDE_AGENT_ID = bundle.slackUserId;
  return out;
}

/** The provider variables a bundle can supply (WS-A §4). */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

/**
 * Node variables that select or authenticate a model provider, as FAMILIES
 * (review R2-F3, re-check F2): the bundled CLI keeps adding provider modes
 * (Bedrock, Vertex, Foundry, Mantle, a gateway mode) with their own switches,
 * keys, identity tokens and client certificates, so a fixed list goes stale.
 * Under the strict rule below a node's value for any of them must not reach a
 * managed persona's child, or the persona would be steered to (or billed on)
 * the node's provider. Every `ANTHROPIC_*` the bundle did not supply goes.
 */
export const PROVIDER_SELECTING_ENV_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_OAUTH_",
  "CLAUDE_CODE_API_KEY_",
  "CLAUDE_CODE_CLIENT_",
  "AWS_",
];
/** Exact names outside the families (and the four a bundle supplies, listed
 *  so they are removed even when the node does not hold them). */
export const PROVIDER_SELECTING_ENV_NAMES: readonly string[] = [...PROVIDER_ENV_KEYS, "GOOGLE_APPLICATION_CREDENTIALS"];

/**
 * Never removed by the strict rule, whatever a family says: what the CLI and
 * slaude need for the child to run at all. None of these matches a family
 * today; the list makes that a tested promise rather than an accident.
 */
export const CHILD_ENV_KEEP: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "CLAUDE_CONFIG_DIR",
  "ENABLE_TOOL_SEARCH",
  "SLAUDE_AGENT_ID",
  "DISABLE_TELEMETRY",
  "DISABLE_AUTOUPDATER",
  "DISABLE_BUG_COMMAND",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

/** The provider-selecting names to delete, given the node's environment. */
export function providerSelectingNames(nodeEnv: Record<string, string | undefined>): string[] {
  const keep = new Set(CHILD_ENV_KEEP);
  const names = new Set<string>(PROVIDER_SELECTING_ENV_NAMES);
  for (const k of Object.keys(nodeEnv)) {
    if (PROVIDER_SELECTING_ENV_PREFIXES.some((p) => k.startsWith(p))) names.add(k);
  }
  return [...names].filter((k) => !keep.has(k));
}

/**
 * The child-env overlay for a session, with the no-silent-fallback rule
 * (WS-A §5.4) applied to a MANAGED bundle. An unmanaged bundle (disk or env
 * tier) is additive exactly as before.
 *
 *   strict when the persona declares its own provider (`ownProvider`, whatever
 *     the flag: its key is only ever sent to its own host, review M-1), or when
 *     SLAUDE_PROVIDER_ENV_FALLBACK=0: a ChildEnvPatch that DELETES every
 *     provider-selecting variable the bundle did not supply; a bundle with no
 *     credential at all (no API key, auth token or OAuth token) fails the boot
 *     with PROVIDER_CREDENTIALS_UNAVAILABLE.
 *   otherwise (fallback on, the default, and no declared provider): additive,
 *     plus `warn(persona, names)` when the node's own environment fills a
 *     provider variable the bundle left out — the persona fell back.
 */
export function nodeChildEnv(
  bundle: Pick<RuntimeBundle, "providerCreds" | "slackUserId" | "managed" | "ownProvider">,
  persona: string,
  opts: { fallback: boolean; nodeEnv: Record<string, string | undefined>; warn: (persona: string, names: string[]) => void },
): Record<string, string | undefined> | ChildEnvPatch {
  const overlay = bundleChildEnv(bundle, persona);
  if (!bundle.managed) return overlay;
  if (opts.fallback && !bundle.ownProvider) {
    const filled = PROVIDER_ENV_KEYS.filter((k) => !overlay[k] && opts.nodeEnv[k]);
    if (filled.length) opts.warn(persona, filled);
    return overlay;
  }
  const c = bundle.providerCreds ?? {};
  if (!c.apiKey && !c.authToken && !c.oauthToken) {
    throw new BootFailure(
      "PROVIDER_CREDENTIALS_UNAVAILABLE",
      `persona '${persona}' has no provider credentials${bundle.ownProvider ? "" : " and SLAUDE_PROVIDER_ENV_FALLBACK=0"}`,
    );
  }
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(overlay)) if (v !== undefined) set[k] = v;
  return new ChildEnvPatch(set, providerSelectingNames(opts.nodeEnv));
}

/**
 * The node's child-env resolver: the session's runtime bundle through
 * nodeChildEnv. The flag is read once, at construction (a malformed value stops
 * the node at start, never mid-turn). With fallback off, a session with no
 * tenant or job token fails its boot instead of spawning on the node's own
 * environment; with fallback on it keeps today's behaviour (no overlay).
 */
export function makeNodeChildEnvResolver(deps: {
  client: Pick<NodeClient, "getRuntime">;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  personaFor: (sessionId: string) => string | undefined;
  fallback?: boolean;
  nodeEnv?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}): (sessionId: string) => Promise<Record<string, string | undefined> | ChildEnvPatch | undefined> {
  const fallback = deps.fallback ?? env.providerEnvFallback();
  const nodeEnv = deps.nodeEnv ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const once = createOnceGuard();
  return async (sessionId) => {
    const tenant = deps.tenantFor(sessionId);
    const token = deps.tokenFor(sessionId);
    if (!tenant || !token) {
      if (fallback) return undefined;
      throw new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", `no tenant or job token for session ${sessionId}`);
    }
    const persona = deps.personaFor(sessionId) ?? "default";
    let bundle: RuntimeBundle;
    try {
      bundle = await deps.client.getRuntime(tenant, persona, token);
    } catch (e) {
      throw bundleFetchFailure(e);
    }
    return nodeChildEnv(bundle, persona, {
      fallback,
      nodeEnv,
      warn: (p, names) => {
        if (!once(`${tenant}\u0000${p}`)) return;
        warn(
          `[node] persona '${p}' (tenant ${tenant}) is running on this node's own ${names.join(", ")}: ` +
            `its bundle supplies none. Set SLAUDE_PROVIDER_ENV_FALLBACK=0 to refuse instead.`,
        );
      },
    });
  };
}

/**
 * The node's persona soul resolver: the soul comes from the runtime bundle for
 * the persona the manager asks for. That persona must agree with the one the
 * job recorded for the session; a disagreement fails the boot rather than run
 * one persona's session on another's soul.
 */
type BundleResolverDeps = {
  client: Pick<NodeClient, "getRuntime">;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  personaFor: (sessionId: string) => string | undefined;
};

/** Fetch the session's bundle for the persona it boots as, refusing a persona
 *  that disagrees with the one the job recorded. */
async function sessionBundle(deps: BundleResolverDeps, sessionId: string, persona: string | undefined): Promise<RuntimeBundle> {
  const tenant = deps.tenantFor(sessionId);
  const token = deps.tokenFor(sessionId);
  if (!tenant || !token) throw new Error(`no tenant or job token for session ${sessionId}`);
  const asked = persona ?? "default";
  const recorded = deps.personaFor(sessionId);
  if (recorded !== undefined && recorded !== asked) {
    throw new Error(`persona mismatch for session ${sessionId}: session boots as '${asked}', job recorded '${recorded}'`);
  }
  try {
    return await deps.client.getRuntime(tenant, asked, token);
  } catch (e) {
    throw e instanceof GateDenied ? labelMismatchBoot(e) : e;
  }
}

/** The bridged MCP server names in the session's runtime bundle (ETag-cached:
 *  the same fetch the soul resolver makes). An older gateway sends none; a
 *  failed fetch mounts none, and the boot's own bundle fetch reports it. */
export function makeBridgedNamesResolver(deps: BundleResolverDeps): (sessionId: string) => Promise<string[]> {
  return async (sessionId) => {
    const tenant = deps.tenantFor(sessionId);
    const token = deps.tokenFor(sessionId);
    if (!tenant || !token) return [];
    try {
      const bundle = await deps.client.getRuntime(tenant, deps.personaFor(sessionId) ?? "default", token);
      const names = (bundle as { mcpServers?: unknown }).mcpServers;
      return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
    } catch {
      return [];
    }
  };
}

export function makeBundleSoulResolver(deps: BundleResolverDeps): (sessionId: string, persona: string | undefined) => Promise<{ soulMd: string; soulJson: unknown }> {
  return async (sessionId, persona) => {
    const bundle = await sessionBundle(deps, sessionId, persona);
    return { soulMd: bundle.soulMd, soulJson: bundle.soulJson };
  };
}

/** The persona's default model from a MANAGED bundle (its effective model, or
 *  SLAUDE_MODEL on the gateway when it sets none). An unmanaged bundle yields
 *  undefined, so the row's model stands exactly as before. The manager only
 *  asks when the row carries no per-thread model. */
export function makeBundleModelResolver(deps: BundleResolverDeps): (sessionId: string, persona: string | undefined) => Promise<string | undefined> {
  return async (sessionId, persona) => {
    const bundle = await sessionBundle(deps, sessionId, persona);
    return bundle.managed ? bundle.defaultModel : undefined;
  };
}

export interface NodeWorkerOpts {
  /** Root for pod-local session config homes. Default: SLAUDE_NODE_CONFIG_ROOT /
   *  /config-home in the node role, else a per-process temp directory. */
  configRoot?: string;
  /** Default: `<hostname>-<rand>` (spec §6). */
  nodeId?: string;
  client?: NodeClient;
  redisUrl?: string;
  keys?: Keys;
  /** The labels this node consumes, from its verified credential (node labels
   *  spec §4.2). Default: `["default"]` — a legacy node. */
  labels?: readonly string[];
  /** BullMQ concurrency PER WORKER. A node runs one worker per label plus one
   *  for its own queue, so its ceiling is `(labels + 1) × concurrency`. */
  concurrency?: number;
  /** Injectable agent (tests use a stub). Default: a fresh AgentManager. */
  agent?: AgentManager;
  heartbeatSec?: number;
  nodeTtlSec?: number;
  drainSec?: number;
  /** /healthz + /metrics port. Default env SLAUDE_NODE_PORT (where 0 also
   *  disables); explicit null = no server; explicit 0 = ephemeral (tests). */
  port?: number | null;
  /** How long a BullMQ worker error keeps /healthz unhealthy. Default 30s. */
  errorWindowMs?: number;
  /** Session-lock knobs (tests shrink them). */
  lock?: { ttlMs?: number; extendEveryMs?: number };
  /** The node stdio MCP manifest (node labels spec §4.10). Default: read from
   *  SLAUDE_NODE_MANIFEST when SLAUDE_ROLE=node. null (the default in any other
   *  role: the simulator, the in-process harness) = today's MCP behaviour. */
  manifest?: NodeManifest | null;
  /** SLAUDE_PROVIDER_ENV_FALLBACK override (tests). Default: env. */
  providerEnvFallback?: boolean;
  /** Hard turn deadline in ms. Default: the job-token TTL (max turn duration). */
  turnTimeoutMs?: number;
  /** BullMQ Worker tuning (tests shrink stall detection to simulate a killed
   *  node whose claimed job must be recovered by a surviving worker). */
  bull?: { lockDuration?: number; stalledInterval?: number; maxStalledCount?: number };
  /** TEST SEAM: awaited right after the turn-done marker is written and
   *  before the processor returns (i.e. before any BullMQ ack) — the window
   *  a kill-after-reply zombie test needs to die in. */
  hooks?: { afterTurn?: (jobId: string, outcome: "done" | "error") => void | Promise<void> };
  /** Backoff of the whoami retry while paused on a 401 (tests shrink it).
   *  Default 5s doubling to 60s. */
  authRetry?: { initialMs?: number; maxMs?: number };
}

/** How long a turn-done marker outlives its job (covers Slack's retry window
 *  and any realistic BullMQ stall-recovery delay by a wide margin). */
const TURN_DONE_TTL_SEC = 3600;

export type NodeWorkerState = "starting" | "ready" | "draining" | "stopped";

export interface NodeWorkerHandle {
  nodeId: string;
  agent: AgentManager;
  store: RestSessionStore;
  /** Sessions this node currently holds warm. */
  warmSessions(): string[];
  /** Lifecycle state driving /healthz and /readyz. */
  state(): NodeWorkerState;
  /** Port the /healthz+/metrics server bound, or null when disabled. */
  httpPort(): number | null;
  /** Graceful drain + full shutdown. */
  stop(opts?: { drainSec?: number }): Promise<void>;
  /** SIGKILL emulation (tests): sever every Redis connection abruptly — no
   *  drain, no deregistration, in-flight turns orphaned. Registry keys and
   *  session locks are left to expire by TTL, BullMQ job locks stop renewing
   *  so a surviving worker's stalled checker recovers the claim — exactly the
   *  failure surface a killed pod leaves behind (spec §6 failure matrix). */
  kill(): void;
  /** TEST SEAM: the command Redis connection (break it to probe /healthz). */
  __cmd: Redis;
  /** TEST SEAM: the BullMQ worker connections (one per label plus one). */
  __bullConns: readonly Redis[];
}

export async function startNodeWorker(opts: NodeWorkerOpts = {}): Promise<NodeWorkerHandle> {
  const nodeId = opts.nodeId ?? `${hostname()}-${randomBytes(3).toString("hex")}`;
  // A node id whose own queue would be a label queue's name is refused before
  // anything is announced or claimed.
  assertNodeIdUsable(nodeId);
  const labels = [...new Set(opts.labels ?? [DEFAULT_LABEL])];
  if (labels.length === 0) throw new Error("a node needs at least one label");
  for (const l of labels) if (!LABEL_RE.test(l)) throw new Error(`malformed node label '${l}'`);
  const labelSet: ReadonlySet<string> = new Set(labels);
  // Before any connection: an invalid manifest stops the node here.
  const manifest = opts.manifest !== undefined ? opts.manifest : env.role() === "node" ? loadNodeManifest() : null;
  const keys = opts.keys ?? makeKeys();
  const url = opts.redisUrl ?? redisUrl();
  const client = opts.client ?? new NodeClient({ baseUrl: env.gatewayUrl(), token: env.nodeToken() });
  const concurrency = opts.concurrency ?? env.nodeConcurrency();
  const hbSec = opts.heartbeatSec ?? envHeartbeatSec();
  const drainSecDefault = opts.drainSec ?? nodeDrainSec();
  const turnTimeoutMs = opts.turnTimeoutMs ?? JOB_TOKEN_TTL_SEC * 1000;
  const errorWindowMs = opts.errorWindowMs ?? 30_000;

  // Lifecycle driving the health endpoints: starting → ready (workers
  // subscribed) → draining (SIGTERM) → stopped. Probes must pull a draining
  // node out of rotation, and a node whose queue/Redis plumbing is erroring
  // must not claim to be healthy.
  let state: NodeWorkerState = "starting";
  let lastWorkerError: { at: number; message: string } | null = null;
  let stopped = false;

  // Connections: one command conn (registry/locks/streams), one subscriber,
  // one per BullMQ worker (blocking claims must never share).
  const cmd: Redis = createRedis(url);
  const sub: Redis = createRedis(url);
  const registry: Registry = makeRegistry({ redis: cmd, keys, heartbeatSec: hbSec, nodeTtlSec: opts.nodeTtlSec });
  const pubsub: PubSub = makePubSub({ redis: cmd, sub, keys });
  // Queue handles for moving a job to its label's queue (a mismatch at claim).
  const turnQueues = new TurnQueues({ connection: cmd, keys });

  const agent = opts.agent ?? new AgentManager();
  const store = new RestSessionStore(client);
  /** sessionId → tenant, for runtime-bundle lookups + reload busting. */
  const tenants = new Map<string, string>();
  /** sessionId → persona. The runtime bundle is per (tenant, persona), so the
   *  child-env resolver needs both or it would fetch another agent's bundle. */
  const personas = new Map<string, string>();
  /** sessionId → the current turn's abort controller (shim long-poll teardown). */
  const turnAborts = new Map<string, AbortController>();
  /** Sessions registered warm in the Redis registry by this node. */
  const warm = new Set<string>();
  /** tenantId → reload-channel unsubscribe. */
  const reloadUnsubs = new Map<string, () => Promise<void>>();
  /** Drop the session's cached runtime bundle (it holds plaintext provider
   *  credentials) when the session unregisters (WS-A §8). Keyed per (tenant,
   *  persona), so another live session of that persona simply refetches. */
  const evictBundle = (sessionId: string) => {
    const tenant = tenants.get(sessionId);
    if (tenant) client.bustRuntime(tenant, personas.get(sessionId) ?? "default");
  };

  agent.setSessionStore(store);
  // Episodic memory runs on the gateway, scoped by the job token (a node has
  // no database or brain); a failure only costs the turn its memory.
  agent.setMemoryProvider(makeNodeMemoryProvider({ client, tokenFor: (id) => store.tokenFor(id) }));
  agent.setPermissionResolver(makeNodePermissionResolver({ client, tokenFor: (id) => store.tokenFor(id) }));
  /**
   * Sessions whose current turn got a label-gate 403 on any gateway call
   * (node labels spec §4.6). The call itself fails (a tool shim returns an
   * isError result); at turn end the job FAILS with LABEL_MISMATCH instead of
   * acknowledging "done", so the gateway re-dispatches it once.
   */
  const gateDenied = new Set<string>();
  agent.setMcpResolver(async (sessionId) => {
    const local: Record<string, McpServerConfig> = {
      ...buildShimServers(sessionId, {
        client,
        tokenFor: (id) => store.tokenFor(id),
        signalFor: (id) => turnAborts.get(id)?.signal,
      }),
      // Token budget stays node-local (spec §3): the live Query is here.
      [SESSION_MCP_NAME]: createSessionMcp({ getSnapshot: () => agent.getTokenSnapshot(sessionId) }),
    };
    // The persona's remote MCP servers, through the gateway (WS-C §4.2): names
    // from the runtime bundle, tool lists fetched once here at boot.
    const bridged = await buildBridgeServers(sessionId, await bridgedNames(sessionId), {
      client,
      tokenFor: (id) => store.tokenFor(id),
      onGateDenied: (id) => {
        gateDenied.add(id);
        console.warn(`[node] gateway refused this node for session=${id} (label gate) on a bridged MCP call`);
      },
    }, new Set(Object.keys(local)));
    return { ...bridged, ...local };
  });
  const bridgedNames = makeBridgedNamesResolver({
    client,
    tenantFor: (id) => tenants.get(id),
    tokenFor: (id) => store.tokenFor(id),
    personaFor: (id) => personas.get(id),
  });
  // The manifest's stdio servers for the persona in the job token's claims
  // (never the payload's personaId); merged before the resolver above, so a
  // bridged or shim server wins a name collision against the manifest.
  if (manifest) {
    agent.setLocalMcpResolver(
      makeNodeLocalMcpResolver({ manifest, client, tenantFor: (id) => tenants.get(id), tokenFor: (id) => store.tokenFor(id) }),
    );
  }
  // Every session's CLAUDE_CONFIG_DIR is pod-local, seeded from the gateway
  // with the access tokens for the turn's owner (the gateway resolves the owner
  // from the job token's runAs). Outside the node role — the simulator and the
  // in-process integration harness — a per-process temp root stands in for the
  // pod's emptyDir.
  const sessionLockOpts = env.sessionLock();
  const configRoot = opts.configRoot ?? nodeConfigRoot() ?? mkdtempSync(join(tmpdir(), `slaude-node-${nodeId}-`));
  const seeder = makeSessionSeeder({
    fetch: (tenant, token) => client.getMcpCredentials(tenant, token),
    tenantFor: (id) => tenants.get(id),
    tokenFor: (id) => store.tokenFor(id),
  });
  agent.setSessionConfigDirResolver(async (sessionId, persona) => {
    const dir = sessionConfigDir(sessionId, persona, configRoot);
    await seeder.atBoot(sessionId, dir);
    return dir;
  });
  // Branch R: when a tool call fails, refresh any needs-auth server this
  // session holds a credential for, through the gateway.
  const recovery = makeAuthRecovery({
    status: (sid) => agent.mcpServerStatus(sid),
    reconnect: (sid, server) => agent.reconnectMcpServer(sid, server),
    refresh: (tenant, token, key, failedHash) => client.refreshMcpCredential(tenant, token, key, failedHash),
    dirFor: (sid) => existingSessionConfigDir(sid, configRoot),
    tenantFor: (id) => tenants.get(id),
    tokenFor: (id) => store.tokenFor(id),
  });
  // The persona soul comes from the runtime bundle, never the shared volume: a
  // node runs a persona whose directory is absent there. ETag-cached in
  // NodeClient — the same fetch the child-env resolver makes, so this costs a
  // 304 at most. A failure (gateway unreachable, persona tombstoned) fails the
  // boot rather than falling back to disk or to the default soul.
  const bundleDeps: BundleResolverDeps = {
    client,
    tenantFor: (id) => tenants.get(id),
    tokenFor: (id) => store.tokenFor(id),
    personaFor: (id) => personas.get(id),
  };
  agent.setPersonaSoulResolver(makeBundleSoulResolver(bundleDeps));
  // The persona's model (git or override) also comes from the bundle; a
  // per-thread /model on the session row still wins (see AgentManager).
  agent.setPersonaModelResolver(makeBundleModelResolver(bundleDeps));
  // A failure here (gateway 503 on an unresolvable reference, gateway
  // unreachable) fails the boot with PROVIDER_CREDENTIALS_UNAVAILABLE.
  agent.setChildEnvResolver(
    makeNodeChildEnvResolver({
      client,
      tenantFor: (id) => tenants.get(id),
      tokenFor: (id) => store.tokenFor(id),
      personaFor: (id) => personas.get(id),
      fallback: opts.providerEnvFallback,
    }),
  );
  // Remote mode (spec §4.5): target from the job token's signed claims; key
  // fetched per handle from the gateway (see ./remote).
  agent.setRemote(makeRemoteResolver(store), makeRemoteFactory({ client, store, tenants }));
  // The /1on1 lock (session-mode block, config identity) from the job token's
  // signed claim: a node has no database to read it from.
  agent.setSessionLockResolver(async (sessionId) => lockFromClaims(store, sessionId));

  /**
   * A 401 for this node's own credential (revoked or expired) PAUSES every
   * claim loop and stops the heartbeat — the node cannot serve, so it must not
   * look alive to warm routing or the unserved-label signal — and logs once.
   * In-flight turns are left to finish or fail. It resumes only after GET
   * /v1/node/whoami succeeds again (a 404 is an older gateway that has
   * already authenticated the request).
   *
   * /healthz stays 200 while paused (review U10b-D): a liveness restart cannot
   * fix a revoked credential and would crash-loop on the boot-time 401. The
   * pause shows as `auth_paused` in the probe body and as the
   * slaude_node_auth_paused gauge, which is what to alert on.
   */
  let claimWorkers: Worker[] = [];
  let authPaused = false;
  metric.nodeAuthPaused.set(0);
  const authRetry = { initialMs: opts.authRetry?.initialMs ?? 5_000, maxMs: opts.authRetry?.maxMs ?? 60_000 };
  function pauseForAuth(): void {
    if (authPaused || stopped) return;
    authPaused = true;
    metric.nodeAuthPaused.set(1);
    console.error(`[node] ${nodeId} the gateway refused this node's credential (401): pausing claims until it is accepted again`);
    void (async () => {
      await Promise.all(claimWorkers.map((w) => w.pause(true).catch(() => {})));
      let delay = authRetry.initialMs;
      while (!stopped) {
        await sleep(delay);
        if (stopped) return;
        try {
          await client.whoami();
          break;
        } catch (e) {
          if (e instanceof NodeApiError && e.status === 404) break;
          delay = Math.min(delay * 2, authRetry.maxMs);
        }
      }
      if (stopped) return;
      await registry.nodeUp(nodeId, labels).catch(() => {});
      for (const w of claimWorkers) w.resume();
      authPaused = false;
      metric.nodeAuthPaused.set(0);
      console.log(`[node] ${nodeId} credential accepted again: resuming claims`);
    })();
  }

  client.setHooks({
    onGateDenied: (jobToken) => {
      const sid = jobToken ? decodeClaims(jobToken)?.session : undefined;
      if (sid) gateDenied.add(sid);
    },
    onNodeUnauthorized: () => pauseForAuth(),
  });

  // Turn-end wait: resolved by the first done/error for the session.
  const turnWaiters = new Map<string, (outcome: "done" | "error") => void>();
  agent.on("event", (e: AgentEvent) => {
    // Every AgentEvent also lands on the events:<session> stream (spec §4) so
    // the gateway can drive Slack reactions/status and surface errors.
    // Exact trim: at MAXLEN 1000 the cost is negligible and it removes the
    // approximate-trim overshoot window, keeping the gateway follower's gap
    // exposure to genuinely >1000-event bursts (which the dispatcher covers
    // via job-completion authority anyway). A turn that hit the label gate
    // never reports "done" (nor its own error): its end goes out as a
    // LABEL_MISMATCH error, which the gateway's follower holds back while it
    // decides on a re-dispatch.
    const ends = (e.type === "done" && !e.autoEvolve) || e.type === "error";
    const out: AgentEvent =
      ends && gateDenied.has(e.sessionId)
        ? { type: "error", sessionId: e.sessionId, error: "label gate refused this node", code: "LABEL_MISMATCH" }
        : e;
    void pubsub.appendEvent(e.sessionId, out, { exact: true }).catch(() => {});
    if (e.type === "toolResult" && (e.result as { is_error?: unknown } | undefined)?.is_error) {
      void recovery.onToolError(e.sessionId).catch(() => {});
    }
    if (e.type === "done" && !e.autoEvolve) turnWaiters.get(e.sessionId)?.("done");
    else if (e.type === "error") turnWaiters.get(e.sessionId)?.("error");
  });

  async function ensureReloadSub(tenantId: string): Promise<void> {
    if (reloadUnsubs.has(tenantId)) return;
    try {
      const onReload = makeTenantReloadHandler({
        bustRuntime: (t) => client.bustRuntime(t),
        reload: (sid) => agent.reloadAfterTurn(sid),
        tenants,
      });
      const unsub = await pubsub.onReload(tenantId, () => onReload(tenantId));
      reloadUnsubs.set(tenantId, unsub);
    } catch (e) {
      console.error(`[node] reload subscribe failed tenant=${tenantId}:`, e);
    }
  }

  async function runTurn(job: Job, data: TurnJob): Promise<"done" | "error" | "skipped"> {
    const sessionId = data.sessionId;
    gateDenied.delete(sessionId);
    const ac = new AbortController();
    turnAborts.set(sessionId, ac);
    const abortAgent = () => {
      // Servicing the abort NOW — also consume the durable flag publishAbort
      // set alongside the publish, or it would linger and silently skip the
      // session's NEXT turn at claim time.
      void pubsub.consumeAbortFlag(sessionId).catch(() => {});
      ac.abort();
      agent.abort(sessionId);
    };
    const unsubAbort = await pubsub.onAbort(sessionId, abortAgent);
    try {
      // One prompt per job: coalesced messages arrive as one turn (spec §2).
      const text = data.messages.map((m) => m.text).join("\n\n");
      const suppress = data.messages.length > 0 && data.messages.every((m) => (m as any).suppress === true);
      if (suppress) agent.suppressNextTurn(sessionId);

      // A warm session picks up tokens the gateway refreshed since it booted:
      // the agent reads the file on every call. A session that is not booted
      // yet is seeded by the config-dir resolver instead.
      const warmDir = existingSessionConfigDir(sessionId, configRoot);
      if (warmDir) await seeder.atTurn(sessionId, warmDir);
      recovery.resetTurn(sessionId);

      const outcome = await new Promise<"done" | "error">((resolve, reject) => {
        const timer = setTimeout(() => {
          console.error(`[node] turn timeout session=${sessionId} — aborting`);
          abortAgent();
        }, turnTimeoutMs);
        timer.unref?.();
        turnWaiters.set(sessionId, (o) => {
          clearTimeout(timer);
          turnWaiters.delete(sessionId);
          resolve(o);
        });
        agent.sendMessage(sessionId, text).catch((e) => {
          clearTimeout(timer);
          turnWaiters.delete(sessionId);
          reject(e);
        });
      });
      // Completion marker BEFORE any ack (processor return / /v1 ack): if
      // this node dies in the ack window, the BullMQ retry finds the marker
      // and completes the job without re-running the turn — the model ran
      // and its Slack posts are already out. Residual at-least-once window:
      // dying between the turn's last Slack post and this write still
      // replays the turn on retry (docs-new/deployment/multi-node.md).
      try {
        await cmd.set(keys.turnDone(String(job.id)), outcome, "EX", TURN_DONE_TTL_SEC, "NX");
      } catch (e) {
        console.error(`[node] turn-done marker write failed job=${job.id}:`, e);
      }
      if (opts.hooks?.afterTurn) await opts.hooks.afterTurn(String(job.id), outcome);
      return outcome;
    } finally {
      turnAborts.delete(sessionId);
      await unsubAbort().catch(() => {});
      // Warm registry: the Query outlives the turn under the idle TTL.
      try {
        if (agent.isLive(sessionId)) {
          await registry.register(sessionId, nodeId);
          warm.add(sessionId);
        } else {
          // No live child (the turn ended it, or its boot failed): its
          // credentials must not outlive it in this node's memory.
          evictBundle(sessionId);
          if (warm.delete(sessionId)) await registry.unregister(sessionId);
        }
      } catch (e) {
        console.error(`[node] registry update failed session=${sessionId}:`, e);
      }
    }
  }

  const processor = async (job: Job, token?: string): Promise<unknown> => {
    const data = job.data as TurnJob;
    const claimLatencySec = Math.max(0, (Date.now() - (data.enqueuedAt || job.timestamp)) / 1000);
    metric.nodeClaimLatency.observe(claimLatencySec);
    // Turn-done marker: a prior attempt of THIS job already ran its agent
    // turn but died before BullMQ acked (kill-after-reply zombie). Re-running
    // would double-post to Slack — complete the job instead. Checked
    // unconditionally, not on attemptsMade: stall recovery re-delivers with
    // attemptsMade still 0, and a first attempt can never see its own marker.
    try {
      if (await cmd.exists(keys.turnDone(String(job.id)))) {
        metric.nodeTurnsTotal.inc({ result: "deduped" });
        void client.ackJob(String(job.id), { sessionId: data.sessionId, result: "done" });
        return { skipped: "turn-done" };
      }
    } catch {
      // Marker unreadable — proceed with the turn (at-least-once).
    }
    // Label check (node labels spec §4.6): a job for a label this node does
    // not carry — warm-routed here before a relabel, or reaped onto `turns` —
    // is MOVED to its label's queue, keeping its id, and this copy completes.
    // Never a delayed re-queue on this node's queue: that would spin. Checked
    // before the abort flag, which belongs to whichever node runs the turn.
    const label = jobLabel(data);
    if (!labelSet.has(label)) {
      const moved = await turnQueues.moveTo(job, label, { claimed: true });
      metric.nodeTurnsTotal.inc({ result: "moved" });
      console.log(`[node] job=${job.id} label=${label} not carried here — moved to ${moved.queue}`);
      return { moved: moved.queue };
    }
    // Durable abort flag: /abort published before any node claimed the job.
    if (await pubsub.consumeAbortFlag(data.sessionId)) {
      metric.nodeTurnsTotal.inc({ result: "skipped" });
      return { skipped: "abort-flag" };
    }
    /** Fail the job with a typed code: the code is the job's failure reason
     *  and rides an error event (unless the turn already sent one), and the
     *  job is not retried. */
    const failTyped = (code: FailureCode, why: string, emit = true): never => {
      console.error(`[node] job failed session=${data.sessionId} job=${job.id} code=${code}: ${why}`);
      if (emit) agent.emit("event", { type: "error", sessionId: data.sessionId, error: why, code } satisfies AgentEvent);
      metric.nodeTurnsTotal.inc({ result: "error" });
      void client.failJob(String(job.id), { sessionId: data.sessionId, code });
      throw new UnrecoverableError(code);
    };
    // Refresh an aging token at claim: minted at ENQUEUE, but the turn's
    // deadline starts NOW — a job that sat in the queue would otherwise run
    // on a mostly-spent (or expired, within the refresh grace) token. A
    // refusal because the agent was relabelled fails the job LABEL_MISMATCH.
    let jobToken: string;
    try {
      jobToken = await tokenAtClaim(client, String(job.id), job.queueName, data.jobToken);
    } catch (e) {
      if (e instanceof BootFailure) failTyped(e.code, e.message);
      throw e;
    }
    // The token is bound under the session lock (runLockedTurn), not here.
    tenants.set(data.sessionId, data.tenantId);
    personas.set(data.sessionId, data.personaId ?? "default");
    // A cron job created inside a /1on1 carries its lock owner. The cron run
    // keys on a synthetic thread with no lock, so this is the only way the node
    // learns whose credentials the turn runs under; without it the turn would
    // silently run as the agent instead.
    if (data.oauthUser) agent.setCronOAuthUser(data.sessionId, data.oauthUser);
    // Subscribe reload:<tenant> BEFORE any runtime-bundle fetch for this
    // tenant can happen (the child-env resolver during ensureSession) — a
    // reload published between fetch and a lazy subscribe would leave a
    // stale cache with nothing to bust it.
    await ensureReloadSub(data.tenantId);

    const started = Date.now();
    let res: "done" | "error" | "skipped" | typeof STALE_CONFIG | typeof HELD_BY_OTHER;
    try {
      res = await runLockedTurn<"done" | "error" | "skipped">({
        lock: (fn) =>
          withSessionLock(
            data.sessionId,
            nodeId,
            fn,
            // The TTL is also the takeover delay when this node dies: it never gets to
            // release the lock, so the re-delivered turn waits the lock out.
            { redis: cmd, keys, ...sessionLockOpts, ...opts.lock },
          ),
        bindToken: (t) => store.bindToken(data.sessionId, t),
        ensureConfigFp: (fp) => agent.ensureConfigFp(data.sessionId, fp),
        jobToken,
        run: async (lostLock) => {
          // Lost the lock (TTL lapsed / another holder): stop touching the
          // session immediately — another node may already be running it.
          const onLost = () => {
            console.error(`[node] session lock lost session=${data.sessionId} — aborting turn`);
            turnAborts.get(data.sessionId)?.abort();
            agent.abort(data.sessionId);
          };
          lostLock.addEventListener("abort", onLost, { once: true });
          try {
            return await runTurn(job, data);
          } finally {
            lostLock.removeEventListener("abort", onLost);
          }
        },
      });
    } catch (e) {
      if (!(e instanceof BootFailure)) throw e;
      gateDenied.delete(data.sessionId);
      // A typed boot failure (WS-A §5.4, §7). A transient one (the secret
      // store or the gateway not answering, review R2-F4) with attempts left
      // takes BullMQ's normal retry, silently. Otherwise the code rides the
      // turn's error event (the gateway posts its fixed text once per job) and
      // is the job's failure reason, and the job fails without a further retry.
      const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      console.error(
        `[node] session boot failed session=${data.sessionId} job=${job.id} code=${e.code} ` +
          `transient=${e.transient}${e.transient && attemptsLeft ? " (will retry)" : ""}`,
      );
      if (e.transient && attemptsLeft) {
        metric.nodeTurnsTotal.inc({ result: "retried" });
        throw new Error(e.code);
      }
      agent.emit("event", { type: "error", sessionId: data.sessionId, error: "session boot failed", code: e.code } satisfies AgentEvent);
      metric.nodeTurnsTotal.inc({ result: "error" });
      void client.failJob(String(job.id), { sessionId: data.sessionId, code: e.code });
      throw new UnrecoverableError(e.code);
    }

    if (res === HELD_BY_OTHER || res === STALE_CONFIG) {
      // Another node is mid-turn on this session, or this node's warm session
      // has a reboot pending — requeue with a short delay (spec §2
      // serialization); never bounce or fail the job.
      metric.nodeTurnsTotal.inc({ result: "requeued" });
      await job.moveToDelayed(Date.now() + 500, token);
      throw new DelayedError();
    }

    metric.nodeTurnDuration.observe((Date.now() - started) / 1000);
    // A call of this turn hit the label gate (node labels spec §4.6): the job
    // fails with LABEL_MISMATCH rather than being acknowledged; the turn's end
    // already went out as that error event.
    if (gateDenied.delete(data.sessionId)) failTyped("LABEL_MISMATCH", "a gateway call of this turn hit the label gate", false);
    metric.nodeTurnsTotal.inc({ result: res });
    if (res === "error") void client.failJob(String(job.id), { sessionId: data.sessionId });
    else void client.ackJob(String(job.id), { sessionId: data.sessionId, result: res });
    return { result: res };
  };

  // Announce liveness (and the labels, same transaction) BEFORE claiming anything.
  await registry.nodeUp(nodeId, labels);

  // One BullMQ worker per label plus this node's own queue, each on its own
  // connection (blocking claims must never share) with its own concurrency.
  // No node-level semaphore: holding claimed jobs active while they wait would
  // starve idle nodes and hide the backlog from the autoscaler, which reads
  // the wait list. A node's ceiling is therefore workers × concurrency.
  const queueNames = [...labels.map(labelTurnsQueue), nodeTurnsQueue(nodeId)];
  // Own the BullMQ connections so kill() can sever them abruptly.
  const bullConns = queueNames.map(() => createRedis(url));
  const workers = queueNames.map(
    (name, i) =>
      new Worker(name, processor, {
        connection: bullConns[i]!,
        prefix: keys.bullPrefix,
        concurrency,
        ...opts.bull,
      }),
  );
  claimWorkers = workers;
  for (const w of workers) {
    w.on("error", (e) => {
      lastWorkerError = { at: Date.now(), message: String((e as Error)?.message ?? e) };
      console.error(`[node] worker error:`, e);
    });
  }
  // Ready once every BullMQ worker has actually subscribed to its queue.
  void Promise.all(workers.map((w) => w.waitUntilReady()))
    .then(() => {
      if (state === "starting") state = "ready";
    })
    .catch((e) => console.error(`[node] workers failed to become ready:`, e));

  // Heartbeats: node liveness + every warm session; drop registry entries for
  // sessions whose Query the idle TTL closed.
  const hbTimer = setInterval(() => {
    void (async () => {
      // Paused on a 401: not serving, so not announced (pauseForAuth).
      if (authPaused) return;
      try {
        await registry.beatNode(nodeId, labels);
        metric.nodeSessionsLive.set(agent.liveCount());
        for (const sessionId of [...warm]) {
          if (agent.isLive(sessionId)) {
            if (!(await registry.heartbeat(sessionId))) await registry.register(sessionId, nodeId);
          } else {
            warm.delete(sessionId);
            evictBundle(sessionId);
            store.unbindToken(sessionId);
            tenants.delete(sessionId);
            personas.delete(sessionId);
            await registry.unregister(sessionId);
          }
        }
      } catch (e) {
        console.error(`[node] heartbeat failed:`, e);
      }
    })();
  }, hbSec * 1000);
  hbTimer.unref?.();

  // /healthz + /readyz + /metrics (spec §6). Both probes gate on the worker
  // lifecycle: a draining node must drop out of rotation, and a node whose
  // BullMQ/Redis plumbing is broken must not report healthy.
  const workersRunning = () => workers.every((w) => w.isRunning());
  // Liveness excuses a claim loop paused on purpose for a refused credential.
  const workersAlive = () => workers.every((w) => w.isRunning() || (authPaused && w.isPaused()));
  const redisReady = () => cmd.status === "ready";
  const recentWorkerError = () => lastWorkerError !== null && Date.now() - lastWorkerError.at < errorWindowMs;
  const healthBody = () => ({
    node_id: nodeId,
    state,
    sessions_live: agent.liveCount(),
    redis: cmd.status,
    workers_running: workersRunning(),
    auth_paused: authPaused,
    ...(lastWorkerError ? { last_worker_error: lastWorkerError } : {}),
  });
  const port = opts.port === undefined ? (env.nodePort() || null) : opts.port;
  const http =
    port === null
      ? null
      : Bun.serve({
          port,
          idleTimeout: 0,
          fetch: async (req) => {
            const path = new URL(req.url).pathname;
            if (path === "/healthz") {
              const healthy = state === "ready" && redisReady() && workersAlive() && !recentWorkerError();
              return Response.json(
                { status: healthy ? "ok" : state === "draining" || state === "stopped" ? "draining" : "unhealthy", ...healthBody() },
                { status: healthy ? 200 : 503 },
              );
            }
            if (path === "/readyz") {
              // Active check: workers subscribed AND Redis answers a PING now.
              if (state !== "ready" || !workersRunning()) {
                return Response.json({ status: "unready", ...healthBody() }, { status: 503 });
              }
              try {
                await cmd.ping();
              } catch (e) {
                return Response.json(
                  { status: "unready", ping_error: String((e as Error)?.message ?? e), ...healthBody() },
                  { status: 503 },
                );
              }
              return Response.json({ status: "ready", ...healthBody() });
            }
            if (path === "/metrics") {
              return new Response(metrics.render(), {
                status: 200,
                headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
              });
            }
            return new Response("not found", { status: 404 });
          },
        });
  if (http) console.log(`[node] ${nodeId} healthz/metrics on :${http.port}`);

  async function stop(o: { drainSec?: number } = {}): Promise<void> {
    if (stopped) return;
    stopped = true;
    state = "draining";
    const grace = (o.drainSec ?? drainSecDefault) * 1000;
    console.log(`[node] ${nodeId} draining (grace ${grace}ms)`);
    clearInterval(hbTimer);
    // Stop claiming; wait for in-flight turns up to the grace, then force.
    const closing = Promise.all(workers.map((w) => w.close()));
    const timedOut = await Promise.race([closing.then(() => false), sleep(grace).then(() => true)]);
    if (timedOut) {
      console.error(`[node] ${nodeId} drain grace expired — force-closing`);
      await Promise.all(workers.map((w) => w.close(true))).catch(() => {});
    }
    // Deregister every warm session + the node itself (spec §2 SIGTERM).
    for (const sessionId of [...warm]) {
      warm.delete(sessionId);
      await registry.unregister(sessionId).catch(() => {});
    }
    await registry.nodeDown(nodeId).catch(() => {});
    for (const unsub of reloadUnsubs.values()) await unsub().catch(() => {});
    reloadUnsubs.clear();
    await pubsub.close().catch(() => {});
    await turnQueues.close().catch(() => {});
    http?.stop(true);
    // The workers are closed: their own connections (one per label plus one)
    // go too, or each stop would leak labels + 1 connections.
    for (const c of [...bullConns, cmd, sub]) {
      try {
        await c.quit();
      } catch {
        c.disconnect();
      }
    }
    state = "stopped";
    console.log(`[node] ${nodeId} stopped`);
  }

  function kill(): void {
    if (stopped) return;
    stopped = true;
    console.log(`[node] ${nodeId} KILLED (no drain)`);
    clearInterval(hbTimer);
    http?.stop(true);
    // Best-effort quiet-down of the claim loops; deliberately NOT awaited — a
    // force-close with an in-flight job can wait on it, and a real SIGKILL
    // waits for nothing.
    for (const w of workers) void w.close(true).catch(() => {});
    // Sever every connection: BullMQ job-lock renewal, the session-lock
    // extender and heartbeats all start failing NOW, like a dead process.
    for (const c of [...bullConns, cmd, sub]) c.disconnect(false);
  }

  console.log(`[node] ${nodeId} up — labels: ${labels.join(",")} queues: ${queueNames.join(", ")} (concurrency ${concurrency} per worker, ceiling ${queueNames.length * concurrency})`);
  return {
    nodeId,
    agent,
    store,
    warmSessions: () => [...warm],
    state: () => state,
    httpPort: () => http?.port ?? null,
    stop,
    kill,
    __cmd: cmd,
    __bullConns: bullConns,
  };
}
