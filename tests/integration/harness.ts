/**
 * Shared plumbing for the multi-node scenario tests (spec §8 integration
 * scenarios). Gated on SLAUDE_REDIS_TEST_URL like tests/queue; every suite
 * runs under its own random key prefix and flushes it afterwards.
 *
 * IMPORTANT: no static src/ imports here — gated suites must load queue/
 * gateway modules only when armed (tests/queue/real.ts pattern), so the
 * redis-less test leg drags none of their coverage. Every boot helper
 * imports dynamically.
 */
import { randomBytes } from "node:crypto";
import { REAL_URL } from "../queue/real";

export { REAL_URL, realEnabled, testPrefix, cleanupPrefix, until, sleep } from "../queue/real";

export const NODE_TOKEN = "scenario-node-token";
export const JOB_SECRET = "scenario-job-secret";

/** Env + soul fixture prep. Call first in beforeAll (armed suites only). */
export async function setupScenarioEnv(): Promise<void> {
  process.env.SLAUDE_BRAIN_DISABLED = "1";
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  const { ensureHome } = await import("../../src/config/home");
  const { writeSoulFixture, WORLD } = await import("../../src/gateway/sim/soul-fixture");
  ensureHome();
  writeSoulFixture(WORLD);
}

export function teardownScenarioEnv(): void {
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
}

export interface Replica {
  /** Gateway-local AgentManager (queue-dispatch follower re-emits here). */
  agent: any;
  /** SimTransport bound to this replica (its own Slack surface). */
  transport: any;
  handle: any;
  qd: any;
  /** Base URL of this replica's /v1 server. */
  url: string;
  dispatches(): number;
  stop(): Promise<void>;
}

/**
 * One gateway replica: createGateway in role=gateway (queue dispatch over the
 * given key prefix) + a SimTransport surface + a live /v1 server. Multiple
 * replicas share Postgres/sqlite through the process-global DB client and
 * Redis through the shared key prefix — exactly the multi-replica topology,
 * minus the network between them and the store.
 */
export async function bootReplica(keys: any, opts: { panel?: boolean } = {}): Promise<Replica> {
  const { AgentManager } = await import("../../src/agent/manager");
  const { SimTransport } = await import("../../src/gateway/sim/transport");
  const { createGateway } = await import("../../src/gateway/core/gateway");
  const { makeQueueDispatch } = await import("../../src/gateway/core/dispatch");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { makePanelLock } = await import("../../src/queue/panel-lock");
  const { Redis } = await import("ioredis");

  const redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const agent = new AgentManager();
  const transport = new SimTransport({
    users: { U0MGR: "Manager", U0APP: "Approver", U0ALICE: "Alice" },
  });
  const infra = {
    turns: new TurnQueues({ connection: redis, keys }),
    registry: makeRegistry({ redis, keys, heartbeatSec: 1 }),
    pubsub: makePubSub({ redis, sub, keys }),
  };
  const inner = makeQueueDispatch(agent, { keys, followPollMs: 25, followLingerMs: 400, infra });
  let dispatched = 0;
  const qd = {
    ...inner,
    dispatch: async (session: any, text: string, meta: any) => {
      dispatched++;
      await inner.dispatch(session, text, meta);
    },
  };
  // Panel injected over the SAME redis + key prefix as the dispatcher so the
  // lock, event stream and warm registry all agree. Short lock TTL so TTL-expiry
  // scenarios are fast.
  const panel = opts.panel
    ? {
        registry: infra.registry,
        pubsub: infra.pubsub,
        panelLock: makePanelLock({ redis, keys, ttlMs: 1500 }),
      }
    : undefined;
  const handle = createGateway(agent, transport, { queueDispatch: qd, panel });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req: Request) =>
      (await handle.fetchV1(req)) ?? (await handle.fetchPanel(req)) ?? new Response("nf", { status: 404 }),
  });
  return {
    agent,
    transport,
    handle,
    qd: inner,
    url: `http://127.0.0.1:${server.port}`,
    dispatches: () => dispatched,
    stop: async () => {
      await inner.close().catch(() => {});
      server.stop(true);
      await handle.stop().catch(() => {});
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

/** One node worker with a SimNodeAgent, pointed at a replica's /v1. */
export async function bootNode(
  keys: any,
  gatewayUrl: string,
  opts: { nodeId?: string; worker?: Record<string, unknown> } = {},
): Promise<{ agent: any; worker: any }> {
  const { SimNodeAgent } = await import("../../src/gateway/sim/cluster");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const agent = new SimNodeAgent();
  const worker = await startNodeWorker({
    nodeId: opts.nodeId ?? `scen-${randomBytes(3).toString("hex")}`,
    client: new NodeClient({ baseUrl: gatewayUrl, token: NODE_TOKEN, baseDelayMs: 5 }),
    redisUrl: REAL_URL,
    keys,
    concurrency: 2,
    agent,
    heartbeatSec: 1,
    nodeTtlSec: 3,
    drainSec: 5,
    port: null,
    lock: { ttlMs: 2000, extendEveryMs: 300 },
    turnTimeoutMs: 30_000,
    ...(opts.worker as object),
  });
  return { agent, worker };
}

/** DM message envelope for SimTransport.feedMessage (thread = own ts). */
export const dm = (channel: string, ts: string, text: string, user = "U0MGR") => ({
  channel,
  user,
  text,
  channel_type: "im",
  team: "T_SIM",
  ts,
  thread_ts: undefined as string | undefined,
});

/** Replies (non-status message posts) on a transport containing a marker. */
export function replies(transport: any, marker: string): any[] {
  return transport.outbound.filter(
    (c: any) => c.kind === "message" && typeof c.text === "string" && c.text.includes(marker),
  );
}
