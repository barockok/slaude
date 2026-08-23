/**
 * Node worker (spec §6): BullMQ workers on the shared `turns` queue and this
 * node's per-node queue, running SDK turns through the existing AgentManager
 * with every gateway dependency swapped for its REST/queue counterpart:
 *
 *   sessions    → RestSessionStore over /v1/sessions
 *   MCP tools   → contract shims POSTing /v1/tools/<server>/<tool>
 *   permissions → shared policy + runtime/can_use_tool + /v1/pending long-poll
 *   child env   → tenant runtime bundle creds (ETag-cached), not process env
 *   events      → appended to the events:<session> Redis stream
 *
 * Per job: consume the durable abort flag (a pre-claim /abort skips the turn),
 * take lock:session:<id> (held elsewhere → delay + requeue, never bounce),
 * run the turn, then keep the Query warm — registered in sess:<id> with
 * heartbeats — until the idle TTL closes it. Losing the lock mid-turn or an
 * abort publish aborts the agent. SIGTERM drains: stop claiming, finish
 * in-flight turns within the grace, deregister everything, exit.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { Worker, DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { AgentManager, type AgentEvent } from "../agent/manager";
import { createSessionMcp, SESSION_MCP_NAME } from "../agent/session-mcp";
import { env } from "../config/env";
import { m as metric, metrics } from "../metrics";
import { makeKeys, nodeTurnsQueue, TURNS_QUEUE, type Keys } from "../queue/keys";
import { createRedis, heartbeatSec as envHeartbeatSec, nodeDrainSec, redisUrl } from "../queue/redis";
import { makeRegistry, type Registry } from "../queue/registry";
import { makePubSub, type PubSub } from "../queue/pubsub";
import { withSessionLock, HELD_BY_OTHER } from "../queue/locks";
import type { TurnJob } from "../queue/turns";
import { NodeClient } from "./client";
import { RestSessionStore } from "./session-store";
import { buildShimServers } from "./shims";
import { makeNodePermissionResolver } from "./shims/permission";
import { JOB_TOKEN_TTL_SEC } from "../gateway/api/auth";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NodeWorkerOpts {
  /** Default: `<hostname>-<rand>` (spec §6). */
  nodeId?: string;
  client?: NodeClient;
  redisUrl?: string;
  keys?: Keys;
  concurrency?: number;
  /** Injectable agent (tests use a stub). Default: a fresh AgentManager. */
  agent?: AgentManager;
  heartbeatSec?: number;
  nodeTtlSec?: number;
  drainSec?: number;
  /** /healthz + /metrics port. Default env SLAUDE_NODE_PORT; null = no server. */
  port?: number | null;
  /** Session-lock knobs (tests shrink them). */
  lock?: { ttlMs?: number; extendEveryMs?: number };
  /** Hard turn deadline in ms. Default: the job-token TTL (max turn duration). */
  turnTimeoutMs?: number;
}

export interface NodeWorkerHandle {
  nodeId: string;
  agent: AgentManager;
  store: RestSessionStore;
  /** Sessions this node currently holds warm. */
  warmSessions(): string[];
  /** Graceful drain + full shutdown. */
  stop(opts?: { drainSec?: number }): Promise<void>;
}

export async function startNodeWorker(opts: NodeWorkerOpts = {}): Promise<NodeWorkerHandle> {
  const nodeId = opts.nodeId ?? `${hostname()}-${randomBytes(3).toString("hex")}`;
  const keys = opts.keys ?? makeKeys();
  const url = opts.redisUrl ?? redisUrl();
  const client = opts.client ?? new NodeClient({ baseUrl: env.gatewayUrl(), token: env.nodeToken() });
  const concurrency = opts.concurrency ?? env.nodeConcurrency();
  const hbSec = opts.heartbeatSec ?? envHeartbeatSec();
  const drainSecDefault = opts.drainSec ?? nodeDrainSec();
  const turnTimeoutMs = opts.turnTimeoutMs ?? JOB_TOKEN_TTL_SEC * 1000;

  // Connections: one command conn (registry/locks/streams), one subscriber,
  // one per BullMQ worker (blocking claims must never share).
  const cmd: Redis = createRedis(url);
  const sub: Redis = createRedis(url);
  const registry: Registry = makeRegistry({ redis: cmd, keys, heartbeatSec: hbSec, nodeTtlSec: opts.nodeTtlSec });
  const pubsub: PubSub = makePubSub({ redis: cmd, sub, keys });

  const agent = opts.agent ?? new AgentManager();
  const store = new RestSessionStore(client);
  /** sessionId → tenant, for runtime-bundle lookups + reload busting. */
  const tenants = new Map<string, string>();
  /** sessionId → the current turn's abort controller (shim long-poll teardown). */
  const turnAborts = new Map<string, AbortController>();
  /** Sessions registered warm in the Redis registry by this node. */
  const warm = new Set<string>();
  /** tenantId → reload-channel unsubscribe. */
  const reloadUnsubs = new Map<string, () => Promise<void>>();

  agent.setSessionStore(store);
  agent.setPermissionResolver(makeNodePermissionResolver({ client, tokenFor: (id) => store.tokenFor(id) }));
  agent.setMcpResolver((sessionId) => ({
    ...buildShimServers(sessionId, {
      client,
      tokenFor: (id) => store.tokenFor(id),
      signalFor: (id) => turnAborts.get(id)?.signal,
    }),
    // Token budget stays node-local (spec §3): the live Query is here.
    [SESSION_MCP_NAME]: createSessionMcp({ getSnapshot: () => agent.getTokenSnapshot(sessionId) }),
  }));
  agent.setChildEnvResolver(async (sessionId) => {
    const tenant = tenants.get(sessionId);
    const token = store.tokenFor(sessionId);
    if (!tenant || !token) return undefined;
    const bundle = await client.getRuntime(tenant, token);
    const creds = bundle.providerCreds ?? {};
    const out: Record<string, string | undefined> = {};
    if (creds.apiKey) out.ANTHROPIC_API_KEY = creds.apiKey;
    if (creds.baseUrl) out.ANTHROPIC_BASE_URL = creds.baseUrl;
    if (creds.authToken) out.ANTHROPIC_AUTH_TOKEN = creds.authToken;
    if (creds.oauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = creds.oauthToken;
    return out;
  });

  // Turn-end wait: resolved by the first done/error for the session.
  const turnWaiters = new Map<string, (outcome: "done" | "error") => void>();
  agent.on("event", (e: AgentEvent) => {
    // Every AgentEvent also lands on the events:<session> stream (spec §4) so
    // the gateway can drive Slack reactions/status and surface errors.
    void pubsub.appendEvent(e.sessionId, e).catch(() => {});
    if (e.type === "done" && !e.autoEvolve) turnWaiters.get(e.sessionId)?.("done");
    else if (e.type === "error") turnWaiters.get(e.sessionId)?.("error");
  });

  async function ensureReloadSub(tenantId: string): Promise<void> {
    if (reloadUnsubs.has(tenantId)) return;
    try {
      const unsub = await pubsub.onReload(tenantId, () => client.bustRuntime(tenantId));
      reloadUnsubs.set(tenantId, unsub);
    } catch (e) {
      console.error(`[node] reload subscribe failed tenant=${tenantId}:`, e);
    }
  }

  async function runTurn(job: Job, data: TurnJob): Promise<"done" | "error" | "skipped"> {
    const sessionId = data.sessionId;
    const ac = new AbortController();
    turnAborts.set(sessionId, ac);
    const abortAgent = () => {
      ac.abort();
      agent.abort(sessionId);
    };
    const unsubAbort = await pubsub.onAbort(sessionId, abortAgent);
    try {
      // One prompt per job: coalesced messages arrive as one turn (spec §2).
      const text = data.messages.map((m) => m.text).join("\n\n");
      const suppress = data.messages.length > 0 && data.messages.every((m) => (m as any).suppress === true);
      if (suppress) agent.suppressNextTurn(sessionId);

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
      return outcome;
    } finally {
      turnAborts.delete(sessionId);
      await unsubAbort().catch(() => {});
      // Warm registry: the Query outlives the turn under the idle TTL.
      try {
        if (agent.isLive(sessionId)) {
          await registry.register(sessionId, nodeId);
          warm.add(sessionId);
        } else if (warm.delete(sessionId)) {
          await registry.unregister(sessionId);
        }
      } catch (e) {
        console.error(`[node] registry update failed session=${sessionId}:`, e);
      }
    }
  }

  const processor = async (job: Job, token?: string): Promise<unknown> => {
    const data = job.data as TurnJob;
    const claimLatencySec = Math.max(0, (Date.now() - (data.enqueuedAt || job.timestamp)) / 1000);
    metric.nodeClaimLatency.set(claimLatencySec);
    // Durable abort flag: /abort published before any node claimed the job.
    if (await pubsub.consumeAbortFlag(data.sessionId)) {
      metric.nodeTurnsTotal.inc({ result: "skipped" });
      return { skipped: "abort-flag" };
    }
    store.bindToken(data.sessionId, data.jobToken);
    tenants.set(data.sessionId, data.tenantId);
    void ensureReloadSub(data.tenantId);

    const started = Date.now();
    const res = await withSessionLock(
      data.sessionId,
      nodeId,
      async (lostLock) => {
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
      { redis: cmd, keys, ...opts.lock },
    );

    if (res === HELD_BY_OTHER) {
      // Another node is mid-turn on this session — requeue with a short
      // delay (spec §2 serialization); never bounce or fail the job.
      metric.nodeTurnsTotal.inc({ result: "requeued" });
      await job.moveToDelayed(Date.now() + 500, token);
      throw new DelayedError();
    }

    metric.nodeTurnDurationSum.inc({}, (Date.now() - started) / 1000);
    metric.nodeTurnsTotal.inc({ result: res });
    if (res === "error") void client.failJob(String(job.id), { sessionId: data.sessionId });
    else void client.ackJob(String(job.id), { sessionId: data.sessionId, result: res });
    return { result: res };
  };

  // Announce liveness BEFORE claiming anything.
  await registry.nodeUp(nodeId);

  const workers = [
    new Worker(TURNS_QUEUE, processor, {
      connection: createRedis(url),
      prefix: keys.bullPrefix,
      concurrency,
    }),
    new Worker(nodeTurnsQueue(nodeId), processor, {
      connection: createRedis(url),
      prefix: keys.bullPrefix,
      concurrency,
    }),
  ];
  for (const w of workers) {
    w.on("error", (e) => console.error(`[node] worker error:`, e));
  }

  // Heartbeats: node liveness + every warm session; drop registry entries for
  // sessions whose Query the idle TTL closed.
  const hbTimer = setInterval(() => {
    void (async () => {
      try {
        await registry.beatNode(nodeId);
        metric.nodeSessionsLive.set(agent.liveCount());
        for (const sessionId of [...warm]) {
          if (agent.isLive(sessionId)) {
            if (!(await registry.heartbeat(sessionId))) await registry.register(sessionId, nodeId);
          } else {
            warm.delete(sessionId);
            store.unbindToken(sessionId);
            tenants.delete(sessionId);
            await registry.unregister(sessionId);
          }
        }
      } catch (e) {
        console.error(`[node] heartbeat failed:`, e);
      }
    })();
  }, hbSec * 1000);
  hbTimer.unref?.();

  // /healthz + /metrics (spec §6).
  const port = opts.port === undefined ? env.nodePort() : opts.port;
  const http =
    port === null || port === 0
      ? null
      : Bun.serve({
          port,
          idleTimeout: 0,
          fetch: async (req) => {
            const path = new URL(req.url).pathname;
            if (path === "/healthz") {
              return Response.json({ status: "ok", node_id: nodeId, sessions_live: agent.liveCount() });
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

  let stopped = false;
  async function stop(o: { drainSec?: number } = {}): Promise<void> {
    if (stopped) return;
    stopped = true;
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
    http?.stop(true);
    for (const c of [cmd, sub]) {
      try {
        await c.quit();
      } catch {
        c.disconnect();
      }
    }
    console.log(`[node] ${nodeId} stopped`);
  }

  console.log(`[node] ${nodeId} up — queues: ${TURNS_QUEUE}, ${nodeTurnsQueue(nodeId)} (concurrency ${concurrency})`);
  return {
    nodeId,
    agent,
    store,
    warmSessions: () => [...warm],
    stop,
  };
}
