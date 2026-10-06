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
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

process.env.SLAUDE_BRAIN_DISABLED = "1";

const NODE_TOKEN = "e2e-node-token";
const JOB_SECRET = "e2e-job-secret";
const NODE_ID = "nodeA-e2e";

const d = describe.skipIf(!realEnabled);

// Everything queue-touching is imported dynamically inside beforeAll so the
// redis-less leg loads none of it (tests/queue/real.ts pattern).
let redis: any;
const nodeConfigRoot = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "we2e-config-"));
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
/** Paths of every /v1/tools/memory request the gateway received. */
const memoryHits: string[] = [];

/** When set, the stub's session boot fails with this error (a BootFailure). */
let bootFailure: Error | null = null;
let busts: Array<[string, string | undefined]> = [];

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
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");

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
  const { parseNodeManifest } = await import("../../src/node/manifest");
  const Sessions = await import("../../src/db/sessions");
  const { metrics } = await import("../../src/metrics");

  metricsRender = () => metrics.render();
  nodeTurnsQueueFn = nodeTurnsQueue;
  acquireLockFn = acquireLock;
  ensureHome();
  writeSoulFixture(WORLD);

  keys = makeKeys(testPrefix("we2e"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  // Interrupted runs never reach afterAll — sweep their leftovers up front.
  await sweepTag(redis, "we2e");
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
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/v1/tools/memory/")) memoryHits.push(path);
      return (await gw.fetchV1(req)) ?? new Response("nf", { status: 404 });
    },
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
    configDirResolver?: (sessionId: string, persona: string | undefined) => Promise<string>;
    lockResolver?: ((sessionId: string) => Promise<any>) | null;
    childEnvResolver?: (sessionId: string) => Promise<unknown>;
    override setChildEnvResolver(r: any) {
      super.setChildEnvResolver(r);
      this.childEnvResolver = r;
    }
    override setSessionLockResolver(r: any) {
      super.setSessionLockResolver(r);
      this.lockResolver = r;
    }
    memoryProvider?: any;
    override setMemoryProvider(p: any) {
      super.setMemoryProvider(p);
      this.memoryProvider = p;
    }
    override setMcpResolver(r: any) {
      super.setMcpResolver(r);
      this.mcp = r;
    }
    localMcp?: (sessionId: string) => Promise<Record<string, unknown>>;
    override setLocalMcpResolver(r: any) {
      super.setLocalMcpResolver(r);
      this.localMcp = r;
    }
    override setSessionConfigDirResolver(r: any) {
      super.setSessionConfigDirResolver(r);
      this.configDirResolver = r;
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
      // The real manager's boot fails this way when the child-env resolver throws.
      if (bootFailure) throw bootFailure;
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
  const bust = client.bustRuntime.bind(client);
  client.bustRuntime = (t: string, p?: string) => {
    busts.push([t, p]);
    bust(t, p);
  };
  // The worker reads SLAUDE_PROVIDER_ENV_FALLBACK once, at start (the stub
  // agent never calls its child-env resolver, so no other case depends on it).
  const savedFallback = process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
  process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "0";
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
    configRoot: nodeConfigRoot,
    // The default persona may mount gh; ops-bot may mount everything.
    manifest: parseNodeManifest(
      JSON.stringify({
        version: 1,
        mcpServers: { gh: { command: "gh-mcp" }, tf: { command: "tf-mcp" } },
        allow: { default: ["gh"], "ops-bot": "*" },
      }),
      {},
      "node.json",
    ),
  });
  if (savedFallback === undefined) delete process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
  else process.env.SLAUDE_PROVIDER_ENV_FALLBACK = savedFallback;
});

afterAll(async () => {
  if (!realEnabled) return;
  await workerHandle?.stop({ drainSec: 1 }).catch(() => {});
  await qd?.close().catch(() => {});
  server?.stop(true);
  // Obliterate the BullMQ queues (drops :meta and every internal structure)
  // before the generic prefix delete.
  if (redis) await obliterateQueues(redis, keys.bullPrefix, ["turns", nodeTurnsQueueFn(NODE_ID)]);
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
  require("node:fs").rmSync(nodeConfigRoot, { recursive: true, force: true });
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

  // WS-A §5.4, §7: a typed boot failure reaches Slack as its fixed text, once,
  // and is the job's failure reason with no retry; the session's cached bundle
  // is evicted since no child holds it.
  test("a provider-credential boot failure posts the fixed text once and fails the job without a retry", async () => {
    const { BootFailure, failureText } = await import("../../src/gateway/core/failure-codes");
    const FAIL_THREAD = "9050.0";
    posts.length = 0;
    busts = [];
    bootFailure = new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", "resolver failed: raw-detail-never-posted");
    try {
      await emitSlack("message", msg(FAIL_THREAD, "9050.1", "<@USLAUDE> hello"));
      const fixed = failureText("PROVIDER_CREDENTIALS_UNAVAILABLE");
      await until(() => posts.some((p) => p.text === fixed), 15_000);
      await sleep(600); // a retry or a second emitter would post again within the follower's linger
      expect(posts.filter((p) => p.text === fixed)).toHaveLength(1);
      expect(posts.map((p) => String(p.text)).join("\n")).not.toContain("raw-detail-never-posted");
      const sid = await sessionIdOf(FAIL_THREAD);
      // The error event can reach Slack before BullMQ records the failure.
      const failedJob = async () =>
        [...(await turnsQ.queue("turns").getFailed()), ...(await turnsQ.queue(nodeTurnsQueueFn(NODE_ID)).getFailed())]
          .find((j: any) => j.data?.sessionId === sid);
      await until(async () => !!(await failedJob()), 10_000);
      const job = await failedJob();
      expect(job?.failedReason).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
      expect(job).toBeDefined();
      expect(job.attemptsMade).toBe(1);
      expect(busts.some(([t]) => t === "default")).toBe(true);
    } finally {
      bootFailure = null;
    }
  }, 30_000);

  // R1-F6: the worker's child-env resolver follows SLAUDE_PROVIDER_ENV_FALLBACK
  // (set to 0 for this worker): a session it knows nothing about fails typed.
  test("the worker installs a child-env resolver that honours SLAUDE_PROVIDER_ENV_FALLBACK", async () => {
    const { BootFailure } = await import("../../src/gateway/core/failure-codes");
    expect(stub.childEnvResolver).toBeDefined();
    const e = await stub.childEnvResolver!("no-such-session").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as any).code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
  });

  // The release-blocking fix lives in the worker's wiring: a node has no
  // database, so the agent's memory provider must be the gateway's routes.
  // (tests/agent/node-memory.test.ts proves the manager puts that provider's
  // block into the SDK's system prompt as <memory-context>.)
  test("the worker routes the agent's memory through the gateway's /v1/tools/memory", async () => {
    const { __setMemoryForTests, memory: original } = await import("../../src/memory");
    const seen: string[] = [];
    __setMemoryForTests({
      prefetch: async (id: string) => (seen.push(id), "<recent-turns>worker memory</recent-turns>"),
      syncTurn: async () => {},
    });
    const MEM_THREAD = "9070.0";
    let block: string | null | undefined;
    const prev = behavior;
    behavior = async (a) => {
      block = await stub.memoryProvider.prefetch(a.sessionId);
      await prev(a);
    };
    try {
      memoryHits.length = 0;
      await emitSlack("message", msg(MEM_THREAD, "9070.1", "<@USLAUDE> remember this"));
      await until(() => block !== undefined, 15_000);
      expect(memoryHits).toContain("/v1/tools/memory/prefetch");
      expect(block).toContain("worker memory");
      expect(seen).toEqual([await sessionIdOf(MEM_THREAD)]);
    } finally {
      behavior = prev;
      __setMemoryForTests(original);
    }
  }, 30_000);

  // R2-F4: a transient failure takes BullMQ's retry silently; the last attempt
  // posts the fixed text once.
  test("a transient boot failure is retried, then posts the fixed text once", async () => {
    const { BootFailure, failureText } = await import("../../src/gateway/core/failure-codes");
    const T_THREAD = "9060.0";
    posts.length = 0;
    bootFailure = new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", "vault not answering", { transient: true });
    try {
      await emitSlack("message", msg(T_THREAD, "9060.1", "<@USLAUDE> hello"));
      const fixed = failureText("PROVIDER_CREDENTIALS_UNAVAILABLE");
      await until(() => posts.some((p) => p.text === fixed), 20_000);
      await sleep(600);
      expect(posts.filter((p) => p.text === fixed)).toHaveLength(1);
      const sid = await sessionIdOf(T_THREAD);
      const failedJob = async () =>
        [...(await turnsQ.queue("turns").getFailed()), ...(await turnsQ.queue(nodeTurnsQueueFn(NODE_ID)).getFailed())]
          .find((j: any) => j.data?.sessionId === sid);
      await until(async () => !!(await failedJob()), 10_000);
      const job = await failedJob();
      expect(job.attemptsMade).toBe(2);
      expect(job.failedReason).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
    } finally {
      bootFailure = null;
    }
  }, 40_000);

  // A cron job created inside a /1on1 carries its lock owner. The cron run keys
  // on a synthetic thread with no lock, so the node can only learn the identity
  // from the job itself — and it must, or the turn runs as the agent instead of
  // as that person.
  test("a job's oauth user is applied on the node before the turn", async () => {
    const CRON_THREAD = "9100.0";
    await emitSlack("message", msg(CRON_THREAD, "9100.1", "<@USLAUDE> seed the session"));
    await until(async () => !!(await sessionIdOf(CRON_THREAD).catch(() => null)), 15_000);
    const sid = await sessionIdOf(CRON_THREAD);

    await qd.dispatch({ id: sid } as any, "[scheduled] work", {
      teamId: "T",
      channelId: "C0TEAM",
      threadTs: CRON_THREAD,
      eventTs: String(Date.now() / 1000),
      userId: "U0MGR",
      oauthUser: "UTESTOWNER1",
    });

    await until(async () => (await stub.resolveEffectiveIdentity(sid)) === "UTESTOWNER1", 15_000);
    expect(await stub.resolveEffectiveIdentity(sid)).toBe("UTESTOWNER1");
  }, 40_000);

  // A node has no database: the /1on1 lock it builds the session-mode block
  // from must come from the job token's signed claim, through the resolver the
  // worker installs (removing that wiring fails here).
  test("the worker installs a lock resolver that reads the job token's lock claim", async () => {
    const LOCK_THREAD = "9200.0";
    const OneOnOne = await import("../../src/db/one-on-one");
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: LOCK_THREAD, lockedUser: "U0MGR", createdBy: "U0MGR" });
    try {
      posts.length = 0;
      await emitSlack("message", msg(LOCK_THREAD, "9200.1", "<@USLAUDE> locked hello"));
      // This thread's own reply: an earlier test's late reply must not end the wait.
      await until(() => posts.some((p) => p.thread_ts === LOCK_THREAD && String(p.text).includes("node-reply:")), 15_000);
      const sid = await sessionIdOf(LOCK_THREAD);
      expect(typeof stub.lockResolver).toBe("function");
      const lock = await stub.lockResolver(sid);
      expect(lock?.locked_user).toBe("U0MGR");
      expect(lock?.open_scope).toBeNull();
    } finally {
      await OneOnOne.unlock("C0TEAM", LOCK_THREAD);
    }
  }, 30_000);

  // Node labels spec §4.10: the manifest allow-list keys on the persona in the
  // job token's claims. A queued payload naming another persona (unsigned) must
  // not widen what the session mounts.
  test("the manifest resolver keys on the job token's persona, never the payload's personaId", async () => {
    const M_THREAD = "9300.0";
    // Only this thread's replies: an earlier session's late reply must not count.
    const replies = () => posts.filter((p) => p.thread_ts === M_THREAD && String(p.text).includes("node-reply:")).length;
    const before = replies();
    await emitSlack("message", msg(M_THREAD, "9300.1", "<@USLAUDE> manifest"));
    await until(() => replies() > before, 15_000);
    const sid = await sessionIdOf(M_THREAD);
    expect(typeof stub.localMcp).toBe("function");
    expect(Object.keys(await stub.localMcp!(sid))).toEqual(["gh"]);

    // Replay the same turn with a forged payload persona allowed everything.
    const ran = async () =>
      [...(await turnsQ.queue("turns").getCompleted()), ...(await turnsQ.queue(nodeTurnsQueueFn(NODE_ID)).getCompleted())].find(
        (j: any) => j.data?.sessionId === sid,
      );
    await until(async () => !!(await ran()), 10_000);
    const job = await ran();
    const mid = replies();
    await turnsQ.queue("turns").add("turn", { ...job.data, personaId: "ops-bot", enqueuedAt: Date.now() }, { jobId: `forged-${sid}` });
    await until(() => replies() > mid, 15_000);
    expect(Object.keys(await stub.localMcp!(sid))).toEqual(["gh"]);
  }, 40_000);

  test("warm routing: second message rides the per-node queue", async () => {
    const sessionId = await sessionIdOf(THREAD);
    // The worker registered the session warm after the first turn.
    await until(async () => (await registryG.lookup(sessionId))?.node === NODE_ID, 10_000);
    await emitSlack("message", msg(THREAD, "9000.2", "warm follow-up"));
    await until(() => posts.filter((p) => String(p.text).includes("node-reply:")).length >= 2, 15_000);
    // The reply lands from inside the turn; BullMQ marks the job "completed" a
    // beat later. Poll for the per-node queue's completed count instead of a
    // one-shot read that races the completion transition under load. Intact
    // assertion: a job that (wrongly) rode the SHARED queue never bumps the
    // per-node count, so this still times out and fails on a routing regression.
    await until(
      async () => ((await turnsQ.queue(nodeTurnsQueueFn(NODE_ID)).getJobCounts("completed")).completed ?? 0) >= 1,
      10_000,
    );
  }, 30_000);

  test("reload:<tenant> subscription is live before/after the first turn (cache bustable)", async () => {
    // The worker awaits the reload subscription BEFORE the turn's first
    // runtime-bundle fetch, so by the time any turn has completed a publish
    // must reach at least one subscriber — no stale-cache window.
    expect(await qd.pubsub.publishReload("default")).toBeGreaterThanOrEqual(1);
  });

  test("cold resume: registry entry gone → shared queue, turn still completes", async () => {
    const sessionId = await sessionIdOf(THREAD);
    stub.liveSet.delete(sessionId); // node dropped the warm Query
    await registryG.unregister(sessionId);
    const before = (await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0;
    await emitSlack("message", msg(THREAD, "9000.3", "cold resume"));
    await until(() => posts.filter((p) => String(p.text).includes("node-reply:")).length >= 3, 15_000);
    // Same settle race as warm-routing: wait for the shared-queue completion to
    // register rather than reading the count the instant the reply posts. A
    // turn that never ran on the shared queue leaves the count flat → times out.
    await until(
      async () => ((await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0) > before,
      10_000,
    );
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
    // A foreign holder takes the session lock with a short TTL. Under CI load
    // the PRIOR test's turn may still hold this session's lock (its extender's
    // teardown lags behind the done event), so a single acquire can race and
    // fail. Poll until the lock actually frees and WE grab it as the foreign
    // holder — acquireLock is an atomic SET NX, so a truthy result means we
    // hold it. This doesn't weaken the assertion: the real test (a job queued
    // behind a foreign lock is requeued, then runs) still runs against a lock
    // we provably hold. TTL stays 2000ms so it frees in time for the requeued
    // job (500ms requeue cadence) to run well within the 20s until() below.
    await until(async () => (await acquireLockFn(redis, keys.sessionLock(sessionId), "someone-else", 2000)) === true, 10_000);
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

  // Phase 3: the node's session config home is pod-local and seeded from the
  // gateway's credential store with the access tokens for the turn's runAs
  // owner. Runs the real /v1 endpoint, the real dispatcher-minted runAs, and
  // the worker's real resolver; only the model turn is stubbed.
  test("an agent turn's pod-local home is seeded with the agent's access token only", async () => {
    const Creds = await import("../../src/db/mcp-credentials");
    const { readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    await Creds.putCredential({ kind: "agent", tenant: "default", persona: "default" }, "workbench|e2e", {
      serverName: "workbench", serverUrl: "https://mcp.example.com", clientId: "c1", clientSecret: "secret-e2e",
      accessToken: "tok-agent-e2e", refreshToken: "refresh-e2e", expiresAt: Date.now() + 3600_000,
    });
    const T = "9500.0";
    await emitSlack("message", msg(T, "9500.1", "<@USLAUDE> seed me"));
    await until(() => posts.some((p) => p.thread_ts === T && String(p.text).includes("node-reply:")), 15_000);
    const sid = await sessionIdOf(T);

    const dir = await stub.configDirResolver!(sid, undefined);

    expect(dir.startsWith(nodeConfigRoot)).toBe(true);
    const file = join(dir, ".credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text).mcpOAuth["workbench|e2e"].accessToken).toBe("tok-agent-e2e");
    expect(text).not.toContain("refresh-e2e");
    expect(text).not.toContain("secret-e2e");
  }, 30_000);

  test("a 1:1 turn's home is seeded with the lock owner's credentials, not the agent's", async () => {
    const Creds = await import("../../src/db/mcp-credentials");
    const Accounts = await import("../../src/db/accounts");
    const OneOnOne = await import("../../src/db/one-on-one");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const a = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "sub-e2e", email: "e2e@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "T", slackUserId: "U0MGR", accountId: a.id, via: "signed-link" });
    await Creds.putCredential({ kind: "account", accountId: a.id }, "workbench|e2e", {
      serverName: "workbench", serverUrl: "https://mcp.example.com", accessToken: "tok-person-e2e", expiresAt: Date.now() + 3600_000,
    });
    const T = "9600.0";
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: T, lockedUser: "U0MGR", createdBy: "U0MGR" });
    await emitSlack("message", msg(T, "9600.1", "<@USLAUDE> seed me as a person"));
    await until(() => posts.some((p) => p.thread_ts === T && String(p.text).includes("node-reply:")), 15_000);
    const sid = await sessionIdOf(T);

    const dir = await stub.configDirResolver!(sid, undefined);

    const text = readFileSync(join(dir, ".credentials.json"), "utf8");
    expect(JSON.parse(text).mcpOAuth["workbench|e2e"].accessToken).toBe("tok-person-e2e");
    expect(text).not.toContain("tok-agent-e2e");
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
