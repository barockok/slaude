/**
 * The worker's side of a gateway refusal (node labels spec §4.6), real Redis,
 * gated:
 *
 *   - a label-gate 403 on a call made during a turn fails the job with code
 *     LABEL_MISMATCH (BullMQ UnrecoverableError, no retry) instead of
 *     acknowledging "done", and the turn's end goes out on the events stream
 *     as a LABEL_MISMATCH error, never as "done";
 *   - a 401 for the node's own credential pauses every claim loop and the
 *     heartbeat, logged once, until whoami succeeds again. /healthz stays 200
 *     meanwhile (a restart cannot fix a revoked credential; it would only
 *     crash-loop on the boot 401) and slaude_node_auth_paused reads 1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const d = describe.skipIf(!realEnabled);

let redis: any;
let keys: any;
let turns: any;
let registry: any;
let pubsub: any;
let node: any;
let mint: (claims: Record<string, unknown>, nowMs?: number) => string;

/** What the fake gateway answers. */
const gw = {
  tool: 200 as 200 | 403,
  refresh: 200 as 200 | 409,
  whoami: 200 as 200 | 401,
  calls: [] as string[],
  fails: [] as unknown[],
};
const NODE_401 = { error: "invalid or missing bearer token", code: "NODE_UNAUTHORIZED" };

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(url).pathname;
  gw.calls.push(path);
  const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  if (path.startsWith("/v1/tools/")) {
    if (gw.whoami === 401) return j(401, NODE_401);
    return gw.tool === 403
      ? j(403, { error: "this node may not serve this agent", code: "GATE_DENIED" })
      : j(200, { content: [{ type: "text", text: "ok" }] });
  }
  if (path.endsWith("/token-refresh") && gw.refresh === 409) {
    return j(409, { error: "the agent's node label changed", code: "LABEL_MISMATCH" });
  }
  if (path === "/v1/node/whoami") {
    return gw.whoami === 401 ? j(401, NODE_401) : j(200, { id: "node-gate", labels: ["default"], legacy: false, expiresInSec: 3600 });
  }
  if (path.endsWith("/fail")) gw.fails.push(JSON.parse(String(init?.body ?? "{}")));
  return j(200, { ok: true });
};

/** sessionId → number of turns the stub ran. */
const ran = new Map<string, number>();

beforeAll(async () => {
  if (!realEnabled) return;
  const { AgentManager } = await import("../../src/agent/manager");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const { makeKeys } = await import("../../src/queue/keys");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { mintJobToken } = await import("../../src/gateway/api/auth");
  const { Redis } = await import("ioredis");
  mint = (c, nowMs) => mintJobToken(c as any, { secret: "gate-test-secret", ...(nowMs ? { now: nowMs } : {}) });

  keys = makeKeys(testPrefix("wgate"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "wgate");
  turns = new TurnQueues({ connection: redis, keys });
  registry = makeRegistry({ redis, keys });
  pubsub = makePubSub({ redis, sub, keys });

  const client = new NodeClient({ baseUrl: "http://gw.example.com", token: "cred", attempts: 1, baseDelayMs: 1, fetchImpl: fakeFetch as any });
  let store: any;
  // A turn that makes one tool call (as a shim would), then ends "done".
  const stub = new (class extends AgentManager {
    override isLive() {
      return false;
    }
    override liveCount() {
      return 0;
    }
    override suppressNextTurn() {}
    override async sendMessage(sessionId: string): Promise<void> {
      ran.set(sessionId, (ran.get(sessionId) ?? 0) + 1);
      const tok = store.tokenFor(sessionId);
      void (async () => {
        await client.postTool("surface", "reply", { text: "hi" }, tok).catch(() => {});
        this.emit("event", { type: "done", sessionId } as any);
      })();
    }
  })();
  node = await startNodeWorker({
    nodeId: "node-gate",
    client,
    redisUrl: REAL_URL,
    keys,
    concurrency: 1,
    agent: stub,
    heartbeatSec: 0.2,
    nodeTtlSec: 0.6,
    drainSec: 2,
    port: 0,
    authRetry: { initialMs: 100, maxMs: 200 },
  });
  store = node.store;
  await until(() => node.state() === "ready", 10_000);
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.stop({ drainSec: 1 }).catch(() => {});
  await turns?.close().catch(() => {});
  await pubsub?.close().catch(() => {});
  if (redis) {
    await obliterateQueues(redis, keys.bullPrefix, ["turns", "turns.node-gate"]);
    await cleanupPrefix(redis, keys.prefix);
    await redis.quit().catch(() => {});
  }
});

const job = (sessionId: string, jobId: string, mintedAgoMs = 0) => ({
  sessionId,
  tenantId: "default",
  personaId: "default",
  label: "default",
  messages: [{ ts: `1700000300.${jobId}`, user: "U1", text: "hi" }],
  jobToken: mint(
    { tenant: "default", persona: "default", session: sessionId, team: "T", channel: "C", thread: "1", initiator: "U1", scope: "turn", job: jobId, label: "default" },
    mintedAgoMs ? Date.now() - mintedAgoMs : undefined,
  ),
  enqueuedAt: Date.now(),
});

d("worker: label gate and node-credential refusals", () => {
  test("a turn whose tool call hits the label gate fails LABEL_MISMATCH, once, and never reports done", async () => {
    gw.tool = 403;
    await turns.enqueueTurn(job("s-gate", "gate1"), { label: "default" }, "gate1");
    await until(async () => (await (await turns.queue("turns").getJob("gate1"))?.getState()) === "failed", 10_000);
    const j = await turns.queue("turns").getJob("gate1");
    expect(j.failedReason).toBe("LABEL_MISMATCH");
    expect(j.attemptsMade).toBe(1); // UnrecoverableError: not retried
    expect(ran.get("s-gate")).toBe(1);
    const events = (await pubsub.readEvents("s-gate")).map((e: any) => e.event);
    expect(events.some((e: any) => e.type === "done")).toBe(false);
    expect(events.filter((e: any) => e.type === "error")).toEqual([
      { type: "error", sessionId: "s-gate", error: "label gate refused this node", code: "LABEL_MISMATCH" },
    ]);
    expect(gw.fails).toContainEqual({ sessionId: "s-gate", code: "LABEL_MISMATCH" });
  });

  test("the flag does not leak: the session's next turn without a refusal is done", async () => {
    gw.tool = 200;
    await turns.enqueueTurn(job("s-gate", "gate2"), { label: "default" }, "gate2");
    await until(async () => (await (await turns.queue("turns").getJob("gate2"))?.getState()) === "completed", 10_000);
  });

  // Review U10b-F: the other road to LABEL_MISMATCH — refused at claim.
  test("an aged token whose refresh is refused 409 LABEL_MISMATCH fails the job LABEL_MISMATCH without running it", async () => {
    gw.refresh = 409;
    try {
      // Minted 10 minutes ago: past a fifth of its TTL, so the node refreshes it at claim.
      await turns.enqueueTurn(job("s-refresh", "refresh1", 10 * 60_000), { label: "default" }, "refresh1");
      await until(async () => (await (await turns.queue("turns").getJob("refresh1"))?.getState()) === "failed", 10_000);
      const j = await turns.queue("turns").getJob("refresh1");
      expect(j.failedReason).toBe("LABEL_MISMATCH");
      expect(j.attemptsMade).toBe(1);
      expect(ran.has("s-refresh")).toBe(false);
      expect(gw.calls).toContain("/v1/jobs/refresh1/token-refresh");
    } finally {
      gw.refresh = 200;
    }
  });

  test("a node-credential 401 pauses claims and the heartbeat until whoami succeeds", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    try {
      gw.whoami = 401;
      await turns.enqueueTurn(job("s-auth", "auth1"), { label: "default" }, "auth1");
      // The turn's call gets the 401: the node pauses.
      await until(() => ran.get("s-auth") === 1, 10_000);
      await until(async () => !(await registry.nodeAlive("node-gate")), 5_000);
      // Nothing more is claimed while paused.
      await turns.enqueueTurn(job("s-auth2", "auth2"), { label: "default" }, "auth2");
      await sleep(800);
      expect(ran.has("s-auth2")).toBe(false);
      expect(await (await turns.queue("turns").getJob("auth2")).getState()).toBe("waiting");
      expect(errors.filter((l) => l.includes("pausing claims"))).toHaveLength(1);
      // Liveness stays green while paused; the pause is a field and a gauge.
      const base = `http://127.0.0.1:${node.httpPort()}`;
      const hz = await fetch(`${base}/healthz`);
      expect(hz.status).toBe(200);
      expect(await hz.json()).toMatchObject({ status: "ok", auth_paused: true });
      expect(await (await fetch(`${base}/metrics`)).text()).toMatch(/^slaude_node_auth_paused 1$/m);
      // The credential is accepted again: claims and the heartbeat resume.
      gw.whoami = 200;
      await until(() => ran.get("s-auth2") === 1, 10_000);
      expect(await registry.nodeAlive("node-gate")).toBe(true);
      const after = (await (await fetch(`http://127.0.0.1:${node.httpPort()}/healthz`)).json()) as { auth_paused?: boolean };
      expect(after.auth_paused).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${node.httpPort()}/metrics`)).text()).toMatch(/^slaude_node_auth_paused 0$/m);
    } finally {
      console.error = orig;
      gw.whoami = 200;
    }
  }, 30_000);
});
