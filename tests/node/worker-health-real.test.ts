/**
 * Node /healthz + /readyz lifecycle (real Redis, gated):
 *
 *   starting → 503 readyz until the BullMQ workers actually subscribe;
 *   ready    → both 200;
 *   redis broken → both 503 (healthz on connection state, readyz on PING);
 *   draining (SIGTERM with an in-flight turn) → both 503 for the whole
 *   drain window, so the probe pulls the node out of rotation while it
 *   finishes its work; stopped → server gone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const d = describe.skipIf(!realEnabled);
const NODE_ID = "health-node";

let redis: any;
let keys: any;
let handle: any;
let turns: any;
let base = "";
let releaseTurn: (() => void) | null = null;

beforeAll(async () => {
  if (!realEnabled) return;
  const { AgentManager } = await import("../../src/agent/manager");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const { makeKeys } = await import("../../src/queue/keys");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { Redis } = await import("ioredis");

  keys = makeKeys(testPrefix("health"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "health"); // interrupted-run leftovers
  turns = new TurnQueues({ connection: redis, keys });

  // Stub agent: each turn parks until the test releases it, then finishes.
  class HangingStub extends AgentManager {
    override isLive() {
      return false;
    }
    override liveCount() {
      return 0;
    }
    override suppressNextTurn() {}
    override async sendMessage(sessionId: string): Promise<void> {
      void (async () => {
        await new Promise<void>((r) => {
          releaseTurn = r;
        });
        this.emit("event", { type: "done", sessionId } as any);
      })();
    }
  }

  handle = await startNodeWorker({
    nodeId: NODE_ID,
    client: new NodeClient({ baseUrl: "http://127.0.0.1:1", token: "unused", attempts: 1, baseDelayMs: 1 }),
    redisUrl: REAL_URL,
    keys,
    concurrency: 1,
    agent: new HangingStub(),
    heartbeatSec: 1,
    drainSec: 20,
    port: 0, // ephemeral — the probes under test
    errorWindowMs: 500,
  });
  base = `http://127.0.0.1:${handle.httpPort()}`;
});

afterAll(async () => {
  if (!realEnabled) return;
  releaseTurn?.();
  await handle?.stop({ drainSec: 1 }).catch(() => {});
  if (redis) await obliterateQueues(redis, keys.bullPrefix, ["turns", `turns.${NODE_ID}`]);
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
});

const get = async (path: string) => fetch(`${base}${path}`);

d("node health probes", () => {
  test("readyz turns 200 once workers subscribe; healthz 200", async () => {
    await until(async () => (await get("/readyz")).status === 200, 10_000);
    expect(handle.state()).toBe("ready");
    const h = await get("/healthz");
    expect(h.status).toBe(200);
    const body = (await h.json()) as any;
    expect(body.node_id).toBe(NODE_ID);
    expect(body.workers_running).toBe(true);
    expect(body.redis).toBe("ready");
  });

  test("broken command connection → healthz and readyz 503; recovery → 200", async () => {
    handle.__cmd.disconnect();
    await until(async () => (await get("/healthz")).status === 503, 5_000);
    expect((await get("/readyz")).status).toBe(503);
    // ioredis reconnects on demand.
    await handle.__cmd.connect();
    await until(async () => (await get("/healthz")).status === 200, 5_000);
    expect((await get("/readyz")).status).toBe(200);
  }, 15_000);

  test("draining after SIGTERM-equivalent stop() → 503 for the whole drain window, then stopped", async () => {
    // Park a turn on the worker so the drain has something in flight.
    await turns.enqueueTurn(
      {
        sessionId: "s-health",
        tenantId: "default",
        personaId: "default",
        messages: [{ ts: "1.1", user: "U1", text: "hang" }],
        jobToken: "opaque", // never used: the stub makes no REST calls
        enqueuedAt: Date.now(),
      },
      { node: NODE_ID },
    );
    await until(() => releaseTurn !== null, 10_000);

    const stopping = handle.stop({ drainSec: 20 });
    // While the in-flight turn drains, both probes must fail — the node has
    // to fall out of rotation but keep serving probes.
    await until(async () => {
      const r = await get("/healthz");
      return r.status === 503 && ((await r.json()) as any).status === "draining";
    }, 5_000);
    expect((await get("/readyz")).status).toBe(503);
    expect(handle.state()).toBe("draining");

    releaseTurn!();
    releaseTurn = null;
    await stopping;
    expect(handle.state()).toBe("stopped");
    // The probe server is gone with the node.
    await expect(get("/healthz")).rejects.toThrow();
  }, 30_000);
});
