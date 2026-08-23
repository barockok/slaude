/**
 * Gateway↔node E2E over real Redis (gated on SLAUDE_REDIS_TEST_URL, own key
 * prefix, cleaned up after): one process hosts a role=gateway createGateway
 * (queue dispatch injected with test infra) + a live /v1 server + a node
 * worker running a stub agent whose "model turn" replies through the REAL
 * shim → REST tool plane.
 *
 * Covered: message → enqueue → claim → shim reply lands in Slack; follower
 * re-emits node events (done ✅ reaction); warm routing to the per-node
 * queue; cold resume via the shared queue; /abort mid-turn; held-by-other
 * delay+requeue; lost-lock abort; SIGTERM drain (last — it stops the node).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, until, sleep } from "../queue/real";

process.env.SLAUDE_BRAIN_DISABLED = "1";

const NODE_TOKEN = "e2e-node-token";
const JOB_SECRET = "e2e-job-secret";
const NODE_ID = "nodeA-e2e";

const d = describe.skipIf(!realEnabled);

// Everything queue-touching is imported dynamically inside beforeAll so the
// redis-less leg loads none of it (tests/queue/real.ts pattern).
let redis: any;
let keys: any;
let turnsQ: any;
let posts: any[] = [];
let reacts: any[] = [];
let emitSlack: (name: string, args: any) => Promise<void>;
let server: any;
let workerHandle: any;
let stub: any;
let registryG: any;
let qd: any;
let nodeTurnsQueueFn: any;
let acquireLockFn: any;
let sessionIdOf: (thread: string) => Promise<string>;
let metricsRender: () => string;

/** Current stub behavior; tests swap it. */
let behavior: (a: { sessionId: string; text: string; servers: any; signal: AbortSignal }) => Promise<void>;

async function callShim(cfg: any, toolName: string, args: Record<string, unknown>): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  if (!realEnabled) return;
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";

  const { ensureHome } = await import("../../src/config/home");
  const { writeSoulFixture, WORLD } = await import("../../src/gateway/sim/soul-fixture");
  const { createGateway } = await import("../../src/gateway/core/gateway");
  const { makeQueueDispatch } = await import("../../src/gateway/core/dispatch");
  const { AgentManager } = await import("../../src/agent/manager");
  const { makeKeys, nodeTurnsQueue } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { acquireLock } = await import("../../src/queue/locks");
  const { Redis } = await import("ioredis");
  const { NodeClient } = await import("../../src/node/client");
  const { startNodeWorker } = await import("../../src/node/worker");
  const Sessions = await import("../../src/db/sessions");
  const { metrics } = await import("../../src/metrics");

  metricsRender = () => metrics.render();
  nodeTurnsQueueFn = nodeTurnsQueue;
  acquireLockFn = acquireLock;
  ensureHome();
  writeSoulFixture(WORLD);

  keys = makeKeys(testPrefix("we2e"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const subG = new Redis(REAL_URL, { maxRetriesPerRequest: null });

  // ---- gateway side ----
  const gwAgent = new AgentManager();
  turnsQ = new TurnQueues({ connection: redis, keys });
  registryG = makeRegistry({ redis, keys, heartbeatSec: 1 });
  const pubsubG = makePubSub({ redis, sub: subG, keys });
  qd = makeQueueDispatch(gwAgent, {
    keys,
    followPollMs: 50,
    followLingerMs: 400,
    infra: { turns: turnsQ, registry: registryG, pubsub: pubsubG },
  });

  const handlers = new Map<string, (args: any) => Promise<void>>();
  const transport: any = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE", team: "T", url: "x" }) },
      chat: {
        postMessage: async (a: any) => {
          posts.push(a);
          return { ok: true, ts: `${posts.length}.1` };
        },
        update: async () => ({ ok: true }),
      },
      reactions: {
        add: async (a: any) => {
          reacts.push(a);
          return { ok: true };
        },
        remove: async () => ({ ok: true }),
      },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({ messages: { matches: [], total: 0 } }) },
      files: { uploadV2: async () => ({ files: [] }) },
    },
    action: () => {},
    use: () => {},
    start: async () => {},
    stop: async () => {},
    event: (name: string, fn: any) => handlers.set(name, fn),
  };
  emitSlack = async (name, args) => {
    await handlers.get(name)?.(args);
  };

  const gw = createGateway(gwAgent, transport, { queueDispatch: qd });
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req: Request) => (await gw.fetchV1(req)) ?? new Response("nf", { status: 404 }),
  });

  sessionIdOf = async (thread: string) =>
    (await Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: thread }))!.id;

  // ---- node side ----
  behavior = async ({ servers, text }) => {
    await callShim(servers["slaude_surface"], "reply", { text: `node-reply: ${text.slice(0, 40)}` });
  };

  class NodeStubAgent extends AgentManager {
    mcp?: any;
    liveSet = new Set<string>();
    aborts = new Map<string, AbortController>();
    abortedSessions: string[] = [];
    override setMcpResolver(r: any) {
      super.setMcpResolver(r);
      this.mcp = r;
    }
    override isLive(id: string) {
      return this.liveSet.has(id);
    }
    override liveCount() {
      return this.liveSet.size;
    }
    override abort(id: string) {
      this.abortedSessions.push(id);
      this.aborts.get(id)?.abort();
    }
    override suppressNextTurn(_id: string) {}
    override async sendMessage(sessionId: string, text: string): Promise<void> {
      this.emit("event", { type: "turnStart", sessionId } as any);
      const ac = new AbortController();
      this.aborts.set(sessionId, ac);
      const servers = (await this.mcp?.(sessionId)) ?? {};
      void (async () => {
        try {
          await behavior({ sessionId, text, servers, signal: ac.signal });
          this.liveSet.add(sessionId); // Query stays warm after the turn
          this.emit("event", { type: "done", sessionId } as any);
        } catch (e) {
          this.emit("event", { type: "error", sessionId, error: String(e) } as any);
        } finally {
          this.aborts.delete(sessionId);
        }
      })();
    }
  }
  stub = new NodeStubAgent();

  const client = new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: NODE_TOKEN, baseDelayMs: 5 });
  workerHandle = await startNodeWorker({
    nodeId: NODE_ID,
    client,
    redisUrl: REAL_URL,
    keys,
    concurrency: 2,
    agent: stub,
    heartbeatSec: 1,
    nodeTtlSec: 3,
    drainSec: 10,
    port: null,
    lock: { ttlMs: 2000, extendEveryMs: 300 },
    turnTimeoutMs: 30_000,
  });
});

afterAll(async () => {
  if (!realEnabled) return;
  await workerHandle?.stop({ drainSec: 1 }).catch(() => {});
  await qd?.close().catch(() => {});
  server?.stop(true);
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

const msg = (thread: string, ts: string, text: string) => ({
  event: {
    type: "message",
    channel: "C0TEAM",
    user: "U0MGR",
    team: "T",
    ts,
    thread_ts: thread,
    text,
  },
  client: { auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE" }) } },
  context: { teamId: "T" },
});

d("gateway↔node E2E (real Redis)", () => {
  const THREAD = "9000.0";

  test("message → enqueue → node claims → shim reply lands via the REST tool plane", async () => {
    posts.length = 0;
    reacts.length = 0;
    await emitSlack("message", msg(THREAD, "9000.1", "<@USLAUDE> hello node"));
    await until(() => posts.some((p) => String(p.text).includes("node-reply:")), 15_000);
    const reply = posts.find((p) => String(p.text).includes("node-reply:"));
    expect(reply.channel).toBe("C0TEAM");
    // Follower re-emitted the node's done → gateway stamped ✅ on the inbound.
    await until(() => reacts.some((r) => r.name === "white_check_mark" && r.timestamp === "9000.1"), 10_000);
  }, 30_000);

  test("warm routing: second message rides the per-node queue", async () => {
    const sessionId = await sessionIdOf(THREAD);
    // The worker registered the session warm after the first turn.
    await until(async () => (await registryG.lookup(sessionId))?.node === NODE_ID, 10_000);
    await emitSlack("message", msg(THREAD, "9000.2", "warm follow-up"));
    await until(() => posts.filter((p) => String(p.text).includes("node-reply:")).length >= 2, 15_000);
    const counts = await turnsQ.queue(nodeTurnsQueueFn(NODE_ID)).getJobCounts("completed");
    expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("cold resume: registry entry gone → shared queue, turn still completes", async () => {
    const sessionId = await sessionIdOf(THREAD);
    stub.liveSet.delete(sessionId); // node dropped the warm Query
    await registryG.unregister(sessionId);
    const before = (await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0;
    await emitSlack("message", msg(THREAD, "9000.3", "cold resume"));
    await until(() => posts.filter((p) => String(p.text).includes("node-reply:")).length >= 3, 15_000);
    const after = (await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0;
    expect(after).toBeGreaterThan(before);
  }, 30_000);

  test("/abort mid-turn reaches the node over pub/sub", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    behavior = async ({ signal }) => {
      signal.addEventListener("abort", () => release(), { once: true });
      await gate; // hang until aborted
    };
    const abortedBefore = stub.abortedSessions.length;
    await emitSlack("message", msg(THREAD, "9000.4", "<@USLAUDE> long task"));
    // Wait until the node actually started the turn (it holds the session lock).
    await until(() => stub.aborts.size > 0, 10_000);
    await emitSlack("message", msg(THREAD, "9000.5", "<@USLAUDE> /abort"));
    await until(() => stub.abortedSessions.length > abortedBefore, 10_000);
    expect(posts.some((p) => String(p.text) === "aborted")).toBe(true);
    // Turn ends (behavior resolves post-abort → done).
    await until(() => stub.aborts.size === 0, 10_000);
    behavior = async ({ servers, text }) => {
      await callShim(servers["slaude_surface"], "reply", { text: `node-reply: ${text.slice(0, 40)}` });
    };
  }, 30_000);

  test("held-by-other: job is delayed + requeued, runs after the lock frees", async () => {
    const sessionId = await sessionIdOf(THREAD);
    // A foreign holder takes the session lock with a short TTL.
    expect(await acquireLockFn(redis, keys.sessionLock(sessionId), "someone-else", 2000)).toBe(true);
    const before = posts.filter((p) => String(p.text).includes("node-reply:")).length;
    await emitSlack("message", msg(THREAD, "9000.6", "queued behind a foreign lock"));
    await until(() => posts.filter((p) => String(p.text).includes("node-reply:")).length > before, 20_000);
    expect(metricsRender()).toContain('slaude_node_turns_total{result="requeued"}');
  }, 30_000);

  test("lost lock mid-turn aborts the agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    behavior = async ({ signal }) => {
      signal.addEventListener("abort", () => release(), { once: true });
      await gate;
    };
    const sessionId = await sessionIdOf(THREAD);
    const abortedBefore = stub.abortedSessions.length;
    await emitSlack("message", msg(THREAD, "9000.7", "<@USLAUDE> another long task"));
    await until(() => stub.aborts.size > 0, 10_000);
    // Yank the lock out from under the extender (compare-owner extend fails).
    await redis.del(keys.sessionLock(sessionId));
    await until(() => stub.abortedSessions.length > abortedBefore, 10_000);
    await until(() => stub.aborts.size === 0, 10_000);
    behavior = async ({ servers, text }) => {
      await callShim(servers["slaude_surface"], "reply", { text: `node-reply: ${text.slice(0, 40)}` });
    };
  }, 30_000);

  test("SIGTERM drain: in-flight turn finishes, node + session keys deregistered", async () => {
    behavior = async ({ servers, text }) => {
      await sleep(700); // in-flight while stop() begins
      await callShim(servers["slaude_surface"], "reply", { text: `node-reply: ${text.slice(0, 40)}` });
    };
    const before = posts.filter((p) => String(p.text).includes("node-reply:")).length;
    await emitSlack("message", msg(THREAD, "9000.8", "drain me"));
    // Give the worker a beat to claim, then drain.
    await until(() => stub.aborts.size > 0, 10_000);
    await workerHandle.stop({ drainSec: 15 });
    // The turn completed during the drain…
    expect(posts.filter((p) => String(p.text).includes("node-reply:")).length).toBeGreaterThan(before);
    // …and the node deregistered itself + its sessions.
    expect(await redis.exists(keys.node(NODE_ID))).toBe(0);
    const { scanKeys } = await import("../../src/queue/registry");
    expect((await scanKeys(redis, keys.sessPattern())).length).toBe(0);
  }, 40_000);
});
