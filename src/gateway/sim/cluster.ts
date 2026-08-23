/**
 * Multi-node sim cluster (`bun sim run --nodes N`, spec §8): one process
 * hosting a role=gateway createGateway (SimTransport Slack surface, queue
 * dispatch) plus N node workers, wired through REAL Redis (BullMQ cannot run
 * on a mock) and a live /v1 server. The same transcript fixtures the mono sim
 * runs must pass unchanged through the full multi-process path:
 *
 *   feedMessage → gateway dedup/gates → enqueueTurn → node claims → StubAgent
 *   behavior over the REST shim tool plane → reply lands via /v1/tools →
 *   events stream → gateway follower re-emits → done.
 *
 * Isolation: every cluster gets a random Redis key prefix; stop() flushes it.
 * The DB is whatever the process runs (sqlite temp home / PGLite / real PG),
 * shared by gateway and /v1 exactly as in prod (nodes have no DB).
 */
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { AgentManager, type AgentEvent, type McpResolver } from "../../agent/manager";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { makeQueueDispatch, type QueueDispatch } from "../core/dispatch";
import { makeKeys, type Keys } from "../../queue/keys";
import { makeRegistry } from "../../queue/registry";
import { makePubSub } from "../../queue/pubsub";
import { TurnQueues } from "../../queue/turns";
import { NodeClient } from "../../node/client";
import { startNodeWorker, type NodeWorkerHandle } from "../../node/worker";
import { BEHAVIORS } from "./stub-agent";
import type { SimTransport } from "./transport";

/** Call one tool on a node-side shim MCP server (in-memory MCP roundtrip). */
export async function callShim(cfg: any, toolName: string, args: Record<string, unknown>): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "sim-cluster", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

const shimText = (res: any): string => res?.content?.[0]?.text ?? "";

export interface NodeBehaviorArgs {
  sessionId: string;
  envelope: string;
  /** Shim MCP servers for this session (REST tool plane). */
  servers: Record<string, any>;
  /** SessionMcpCtx-shaped adapter over the shims — what sim BEHAVIORS use. */
  ctx: any;
  emit: (e: AgentEvent) => void;
}

/**
 * Node-side stub agent: runs the SAME sim behaviors the mono StubAgent runs,
 * but through the node's shim tool plane (ctx.surface.* → POST /v1/tools/…),
 * so the fixtures exercise the real multi-node wire. Tests may override
 * `run` for scenario-specific behaviors.
 */
export class SimNodeAgent extends AgentManager {
  #resolver?: McpResolver;
  behavior = "reply";
  /** Overridable turn body; default = named sim behavior over the shims. */
  run: (a: NodeBehaviorArgs) => Promise<void>;
  #live = new Set<string>();
  #aborts = new Map<string, AbortController>();

  constructor() {
    super();
    this.run = async ({ sessionId, envelope, ctx, emit }) => {
      const beh = BEHAVIORS[this.behavior];
      if (!beh) throw new Error(`unknown sim behavior: ${this.behavior}`);
      await beh({ sessionId, envelope, ctx, emit });
    };
  }

  override setMcpResolver(r: McpResolver | undefined) {
    super.setMcpResolver(r);
    this.#resolver = r;
  }
  override isLive(id: string) {
    return this.#live.has(id);
  }
  override liveCount() {
    return this.#live.size;
  }
  override suppressNextTurn(_id: string) {
    /* stub parity with mono StubAgent: suppression doesn't change the reply */
  }
  override abort(id: string) {
    this.#aborts.get(id)?.abort();
  }
  /** Drop the warm Query for a session (scenario tests force cold resumes). */
  dropLive(id: string) {
    this.#live.delete(id);
  }

  override async sendMessage(sessionId: string, envelope: string): Promise<void> {
    this.emit("event", { type: "turnStart", sessionId } as AgentEvent);
    const servers = ((await this.#resolver?.(sessionId)) ?? {}) as Record<string, any>;
    const ac = new AbortController();
    this.#aborts.set(sessionId, ac);
    const emit = (e: AgentEvent) => this.emit("event", e);
    // SessionMcpCtx-shaped adapter over the shim tool plane. Sim behaviors
    // only touch ctx.surface.{reply,requestApproval}; requestApproval blocks
    // on the shim's /v1/pending long-poll exactly like a real node turn.
    const ctx = {
      surface: {
        reply: async (a: { text: string }) => {
          const res = await callShim(servers["slaude_surface"], "reply", a);
          if (res?.isError) throw new Error(`shim reply failed: ${shimText(res)}`);
        },
        requestApproval: async (a: Record<string, unknown>) => {
          const res = await callShim(servers["slaude_surface"], "request_approval", a);
          const text = shimText(res);
          if (res?.isError) throw new Error(`shim request_approval failed: ${text}`);
          const approved = text.match(/^approved by <@([^>]+)>$/);
          if (approved) return { approved: true, by: approved[1]! };
          const denied = text.match(/^denied by <@([^>]+)>(?: \((.*)\))?$/);
          if (denied) return { approved: false, by: denied[1]!, note: denied[2] };
          throw new Error(`unparseable approval outcome: ${text}`);
        },
      },
    };
    // Detached like the real SDK turn: sendMessage resolves once the turn is
    // launched; the worker observes completion via done/error events.
    void (async () => {
      try {
        await this.run({ sessionId, envelope, servers, ctx, emit });
        this.#live.add(sessionId); // Query stays warm after the turn
        emit({ type: "done", sessionId } as AgentEvent);
      } catch (e) {
        emit({ type: "error", sessionId, error: String(e) } as AgentEvent);
      } finally {
        this.#aborts.delete(sessionId);
      }
    })();
  }
}

export interface SimClusterOpts {
  nodes: number;
  transport: SimTransport;
  redisUrl?: string;
  keys?: Keys;
  /** Per-node worker tuning overrides (tests). */
  worker?: Partial<Parameters<typeof startNodeWorker>[0]>;
}

export interface SimCluster {
  handle: GatewayHandle;
  /** Gateway-local AgentManager — pure event emitter (followers re-emit here). */
  gwAgent: AgentManager;
  nodeAgents: SimNodeAgent[];
  workers: NodeWorkerHandle[];
  keys: Keys;
  /** Base URL of the gateway's /v1 server (nodes' REST plane). */
  v1Url: string;
  /** How many turns the gateway dispatched onto the queue so far. */
  dispatches(): number;
  setBehavior(name: string): void;
  /** Boot one more node worker (scenario tests: late joiners, per-node opts). */
  addNode(opts?: {
    agent?: SimNodeAgent;
    nodeId?: string;
    worker?: Partial<Parameters<typeof startNodeWorker>[0]>;
  }): Promise<{ agent: SimNodeAgent; worker: NodeWorkerHandle }>;
  stop(): Promise<void>;
}

export function simRedisUrl(): string {
  const url = process.env.SLAUDE_REDIS_URL || process.env.SLAUDE_REDIS_TEST_URL;
  if (!url) {
    throw new Error(
      "sim --nodes requires a real Redis (BullMQ cannot run on a mock): set SLAUDE_REDIS_URL, e.g. redis://localhost:6379",
    );
  }
  return url;
}

/** Delete every key under the cluster's prefix (teardown hygiene). */
async function flushPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

export async function startSimCluster(opts: SimClusterOpts): Promise<SimCluster> {
  const url = opts.redisUrl ?? simRedisUrl();
  const keys = opts.keys ?? makeKeys(`slaudesim-${randomBytes(4).toString("hex")}`);

  // The /v1 auth plane needs a node bearer + job-token secret; the sim runs
  // in an isolated home, so deterministic defaults are fine.
  process.env.SLAUDE_NODE_TOKEN ??= "sim-node-token";
  process.env.SLAUDE_JOB_SECRET ??= "sim-job-secret";
  const nodeToken = process.env.SLAUDE_NODE_TOKEN;

  const redis = new Redis(url, { maxRetriesPerRequest: null });
  const sub = new Redis(url, { maxRetriesPerRequest: null });

  const gwAgent = new AgentManager();
  const turns = new TurnQueues({ connection: redis, keys });
  const registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  const pubsub = makePubSub({ redis, sub, keys });
  const inner = makeQueueDispatch(gwAgent, {
    keys,
    followPollMs: 25,
    followLingerMs: 500,
    infra: { turns, registry, pubsub },
  });
  let dispatched = 0;
  const qd: QueueDispatch = {
    ...inner,
    dispatch: async (session, text, meta) => {
      dispatched++;
      await inner.dispatch(session, text, meta);
    },
  };

  const handle = createGateway(gwAgent, opts.transport, { queueDispatch: qd });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req: Request) => (await handle.fetchV1(req)) ?? new Response("not found", { status: 404 }),
  });

  const v1Url = `http://127.0.0.1:${server.port}`;
  const nodeAgents: SimNodeAgent[] = [];
  const workers: NodeWorkerHandle[] = [];
  const addNode = async (o: {
    agent?: SimNodeAgent;
    nodeId?: string;
    worker?: Partial<Parameters<typeof startNodeWorker>[0]>;
  } = {}) => {
    const agent = o.agent ?? new SimNodeAgent();
    const worker = await startNodeWorker({
      nodeId: o.nodeId ?? `sim-node-${nodeAgents.length + 1}-${randomBytes(2).toString("hex")}`,
      client: new NodeClient({ baseUrl: v1Url, token: nodeToken, baseDelayMs: 5 }),
      redisUrl: url,
      keys,
      concurrency: 2,
      agent,
      heartbeatSec: 1,
      nodeTtlSec: 3,
      drainSec: 5,
      port: null,
      lock: { ttlMs: 2000, extendEveryMs: 300 },
      turnTimeoutMs: 60_000,
      ...opts.worker,
      ...o.worker,
    });
    nodeAgents.push(agent);
    workers.push(worker);
    return { agent, worker };
  };
  for (let i = 0; i < opts.nodes; i++) await addNode();

  return {
    handle,
    gwAgent,
    nodeAgents,
    workers,
    keys,
    v1Url,
    addNode,
    dispatches: () => dispatched,
    setBehavior: (name) => {
      for (const a of nodeAgents) a.behavior = name;
    },
    async stop() {
      for (const w of workers) await w.stop({ drainSec: 2 }).catch(() => {});
      await qd.close().catch(() => {});
      server.stop(true);
      await flushPrefix(redis, keys.prefix).catch(() => {});
      for (const c of [redis, sub]) {
        try {
          await c.quit();
        } catch {
          c.disconnect();
        }
      }
    },
  };
}
