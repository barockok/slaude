/**
 * Label queues end to end on the worker (node labels spec §4.6, §4.8), real
 * Redis, gated. Two nodes in one process:
 *
 *   node-eng  carries `engineering`
 *   node-def  carries `default` (a legacy-shaped node)
 *
 * A persona on `engineering` only ever runs on node-eng; a job with no label
 * (an older gateway) runs on `default`; a job claimed by a node that lacks its
 * label is MOVED to its label's queue once — not re-queued on the wrong one
 * (the 500 ms hot loop) — and a job for a label no node carries waits on that
 * label's queue.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const d = describe.skipIf(!realEnabled);

let redis: any;
let keys: any;
let turns: any;
let registry: any;
let nodes: any[] = [];
let movedCount: () => number = () => 0;
/** sessionId → the node ids that ran a turn for it. */
const ran = new Map<string, string[]>();

beforeAll(async () => {
  if (!realEnabled) return;
  const { AgentManager } = await import("../../src/agent/manager");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const { makeKeys } = await import("../../src/queue/keys");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { metrics } = await import("../../src/metrics");
  const { Redis } = await import("ioredis");

  keys = makeKeys(testPrefix("wlabels"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "wlabels");
  turns = new TurnQueues({ connection: redis, keys });
  registry = makeRegistry({ redis, keys });
  movedCount = () => Number(/slaude_node_turns_total\{result="moved"\} (\d+)/.exec(metrics.render())?.[1] ?? 0);

  const stub = (nodeId: string) =>
    new (class extends AgentManager {
      override isLive() {
        return false;
      }
      override liveCount() {
        return 0;
      }
      override suppressNextTurn() {}
      override async sendMessage(sessionId: string): Promise<void> {
        ran.set(sessionId, [...(ran.get(sessionId) ?? []), nodeId]);
        queueMicrotask(() => this.emit("event", { type: "done", sessionId } as any));
      }
    })();

  const start = (nodeId: string, labels?: string[]) =>
    startNodeWorker({
      nodeId,
      ...(labels ? { labels } : {}),
      client: new NodeClient({ baseUrl: "http://127.0.0.1:1", token: "unused", attempts: 1, baseDelayMs: 1 }),
      redisUrl: REAL_URL,
      keys,
      concurrency: 2,
      agent: stub(nodeId),
      heartbeatSec: 1,
      drainSec: 2,
      port: null,
    });
  nodes = [await start("node-eng", ["engineering"]), await start("node-def")];
  await until(() => nodes.every((n) => n.state() === "ready"), 10_000);
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const n of nodes) await n.stop({ drainSec: 1 }).catch(() => {});
  await turns?.close().catch(() => {});
  if (redis) {
    await obliterateQueues(redis, keys.bullPrefix, [
      "turns", "turns.label.engineering", "turns.label.finance", "turns.node-eng", "turns.node-def",
    ]);
    await cleanupPrefix(redis, keys.prefix);
    await redis.quit().catch(() => {});
  }
});

const job = (sessionId: string, label?: string) => ({
  sessionId,
  tenantId: "default",
  personaId: "default",
  ...(label ? { label } : {}),
  messages: [{ ts: "1.1", user: "U1", text: "hi" }],
  jobToken: "opaque", // never used: the stub makes no REST calls
  enqueuedAt: Date.now(),
});

d("worker label queues", () => {
  test("each node publishes the labels it consumes; the legacy-shaped node is {default}", async () => {
    expect([...(await registry.nodeLabels("node-eng"))]).toEqual(["engineering"]);
    expect([...(await registry.nodeLabels("node-def"))]).toEqual(["default"]);
    expect(await registry.nodesWithLabel("engineering")).toEqual(["node-eng"]);
  });

  test("a persona on engineering only ever runs on the engineering node", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `s-eng-${i}`);
    for (const id of ids) await turns.enqueueTurn(job(id, "engineering"), { label: "engineering" });
    await until(() => ids.every((id) => ran.has(id)), 10_000);
    for (const id of ids) expect(ran.get(id)).toEqual(["node-eng"]);
  });

  test("a persona with no runs_on, and an old job with no label, run on default", async () => {
    await turns.enqueueTurn(job("s-def-new", "default"), { label: "default" });
    await turns.enqueueTurn(job("s-def-old"), "shared"); // an older gateway: no label in the payload
    await until(() => ran.has("s-def-new") && ran.has("s-def-old"), 10_000);
    expect(ran.get("s-def-new")).toEqual(["node-def"]);
    expect(ran.get("s-def-old")).toEqual(["node-def"]);
  });

  test("a job claimed by a node without its label is moved once to the label's queue and runs there", async () => {
    const before = movedCount();
    // Lands on `turns` (e.g. reaped there, or warm-routed before a relabel)
    // while its payload says engineering: node-def claims it and must move it.
    const res = await turns.enqueueTurn(job("s-mismatch", "engineering"), { label: "default" }, "mismatch-1");
    expect(res.queue).toBe("turns");
    await until(() => ran.has("s-mismatch"), 10_000);
    expect(ran.get("s-mismatch")).toEqual(["node-eng"]);
    // The copy on `turns` completed as moved; same id on the label queue.
    const orig = await turns.queue("turns").getJob("mismatch-1");
    expect(await orig.getState()).toBe("completed");
    expect(orig.returnvalue).toEqual({ moved: "turns.label.engineering" });
    expect(await turns.movedTo("mismatch-1")).toEqual({ queue: "turns.label.engineering", jobId: "mismatch-1" });
    expect(movedCount() - before).toBe(1);
  });

  test("a job for a label no node carries is moved once and waits there: no hot loop", async () => {
    const before = movedCount();
    await turns.enqueueTurn(job("s-finance", "finance"), { label: "default" }, "finance-1");
    await until(async () => (await turns.queue("turns.label.finance").getWaitingCount()) === 1, 10_000);
    await sleep(1500); // ample time for a delayed re-queue loop to show itself
    expect(movedCount() - before).toBe(1);
    expect(ran.has("s-finance")).toBe(false);
    const counts = await turns.queue("turns").getJobCounts("waiting", "active", "delayed");
    expect(counts.waiting + counts.active + counts.delayed).toBe(0);
    expect(await turns.queue("turns.label.finance").getWaitingCount()).toBe(1);
  });

  test("a node id that would collide with a label queue is refused at startup", async () => {
    const { startNodeWorker } = await import("../../src/node/worker");
    await expect(startNodeWorker({ nodeId: "label.finance", redisUrl: REAL_URL, keys, port: null })).rejects.toThrow(/reserved/);
    await expect(startNodeWorker({ nodeId: "n-bad", labels: ["Bad Label"], redisUrl: REAL_URL, keys, port: null })).rejects.toThrow(/malformed/);
  });
});
