/**
 * Capacity, admission and drain on real node workers (box plan, Phase 6),
 * real Redis, gated on SLAUDE_REDIS_TEST_URL. Two workers in one process, each
 * with a FAKE sandbox driver (no sandbox is started: the gVisor driver is a
 * later phase) and room for exactly one box:
 *
 *   - a node at capacity parks an idle session to admit a new one;
 *   - a warm session's turn runs on a full node;
 *   - with none idle the node hands the job back and pauses its label queue,
 *     and a second node claims the job, which runs once;
 *   - a job routed to a full node's own queue comes back to the label queue
 *     and runs once, on the other node;
 *   - drain stops every warm box before the worker exits.
 *
 * The pressure rule and the independence of the two pause reasons are covered
 * without Redis in tests/node/box-runtime.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const d = describe.skipIf(!realEnabled);

let redis: any;
let keys: any;
let turns: any;
let registry: any;
let handedBack: () => number = () => 0;
/** 1 while a node in this process has its label queues paused for capacity. */
let pausedForRoom: () => number = () => 0;
/** How many label-queue workers of this suite are blocked in Redis waiting for a job. */
let labelWorkersWaiting: () => Promise<number> = async () => 0;
let nodeQueue: (id: string) => string;
/** sessionId to the node ids that ran a turn for it, in order. */
const ran = new Map<string, string[]>();
/** Sessions whose turn blocks until released. */
const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
const nodes: Record<string, { worker: any; driver: any; agent: any }> = {};
let startNode: (nodeId: string, pressureIdleSec: number) => Promise<void>;

function hold(sessionId: string): void {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  holds.set(sessionId, { promise, release });
}

beforeAll(async () => {
  if (!realEnabled) return;
  const { AgentManager } = await import("../../src/agent/manager");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const { makeKeys, nodeTurnsQueue } = await import("../../src/queue/keys");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { metrics } = await import("../../src/metrics");
  const { Redis } = await import("ioredis");
  const { fakeBox, fakeDriver, fakeSpec } = await import("../helpers/fake-sandbox");

  nodeQueue = nodeTurnsQueue;
  keys = makeKeys(testPrefix("boxcap"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "boxcap");
  turns = new TurnQueues({ connection: redis, keys });
  registry = makeRegistry({ redis, keys });
  handedBack = () => Number(/slaude_node_turns_total\{result="handed_back"\} (\d+)/.exec(metrics.render())?.[1] ?? 0);
  pausedForRoom = () => Number(/^slaude_node_boxes_full (\d+)/m.exec(metrics.render())?.[1] ?? 0);
  // BullMQ names a worker's blocking connection `<prefix>:<base64 queue name>`, and Redis flags a client `b`
  // while it sits in a blocking command. The prefix is this suite's own, so no other suite's worker is counted.
  const labelClient = `name=${keys.bullPrefix}:${Buffer.from("turns").toString("base64")} `;
  labelWorkersWaiting = async () =>
    String(await redis.client("LIST"))
      .split("\n")
      .filter((l) => l.includes(labelClient) && /\bflags=\S*b/.test(l)).length;

  /** A stub agent that keeps a session "live" after its turn, and can hold a turn in flight. */
  const stub = (nodeId: string) =>
    new (class extends AgentManager {
      live = new Set<string>();
      inTurn = new Set<string>();
      override isLive(id: string) {
        return this.live.has(id);
      }
      override liveCount() {
        return this.live.size;
      }
      override turnRunning(id: string) {
        return this.inTurn.has(id);
      }
      override reload(id: string) {
        return this.live.delete(id);
      }
      override suppressNextTurn() {}
      override async sendMessage(sessionId: string): Promise<void> {
        ran.set(sessionId, [...(ran.get(sessionId) ?? []), nodeId]);
        this.live.add(sessionId);
        this.inTurn.add(sessionId);
        void (async () => {
          await holds.get(sessionId)?.promise;
          holds.delete(sessionId);
          this.inTurn.delete(sessionId);
          this.emit("event", { type: "done", sessionId } as any);
        })();
      }
    })();

  startNode = async (nodeId, pressureIdleSec) => {
    const driver = fakeDriver("gvisor");
    const agent = stub(nodeId);
    const worker = await startNodeWorker({
      nodeId,
      client: new NodeClient({ baseUrl: "http://127.0.0.1:1", token: "unused", attempts: 1, baseDelayMs: 1 }),
      redisUrl: REAL_URL,
      keys,
      concurrency: 2,
      agent,
      heartbeatSec: 1,
      drainSec: 2,
      port: null,
      box: {
        tier: "gvisor",
        driver,
        images: null,
        boxOf: async () => fakeBox(),
        specFor: (id: string, box: any) => fakeSpec(id, box),
        limits: () => ({ memoryLimitMb: 16384, diskMb: 200_000 }),
        capacity: { maxBoxes: 1, memoryBudgetMb: 1174, overheadMb: 150, pressureIdleSec },
        tickMs: 100,
      },
    });
    nodes[nodeId] = { worker, driver, agent };
    await until(() => worker.state() === "ready", 10_000);
  };
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const h of holds.values()) h.release();
  for (const n of Object.values(nodes)) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await turns?.close().catch(() => {});
  if (redis) {
    await obliterateQueues(redis, keys.bullPrefix, ["turns", "turns.cap-A", "turns.cap-B"]);
    await cleanupPrefix(redis, keys.prefix);
    await redis.quit().catch(() => {});
  }
});

let seq = 0;
const job = (sessionId: string) => ({
  sessionId,
  tenantId: "default",
  personaId: "default",
  label: "default",
  messages: [{ ts: `1.${++seq}`, user: "U1", text: "hi" }],
  jobToken: "opaque", // never used: the stub makes no REST calls
  enqueuedAt: Date.now(),
});
const created = (driver: any, sessionId: string) => driver.events.filter((e: string) => e === `create ${sessionId}`).length;

d("box capacity on node workers (real Redis, fake driver)", () => {
  test("a node on a sandbox tier announces its box capabilities and its capacity", async () => {
    await startNode("cap-A", 0);
    const caps = await registry.nodeCaps("cap-A");
    expect(caps.has("box/1")).toBe(true);
    expect(caps.has("box-tier/gvisor")).toBe(true);
    expect(await registry.nodeBoxes("cap-A")).toEqual({ digests: [], running: 0, capacity: 1, free: 1 });
  }, 20_000);

  test("a node at capacity parks an idle session to admit a new one", async () => {
    const { driver } = nodes["cap-A"]!;
    await turns.enqueueTurn(job("s1"), { label: "default" });
    await until(() => (ran.get("s1") ?? []).length === 1, 10_000);
    await until(() => driver.running.includes("s1"), 5_000);
    await until(async () => (await registry.lookup("s1")) !== null, 5_000);
    // The node's one slot is taken. s1 is idle, and this node parks an idle session at once (pressureIdleSec 0).
    await turns.enqueueTurn(job("s2"), { label: "default" });
    await until(() => (ran.get("s2") ?? []).length === 1, 10_000);
    expect(ran.get("s2")).toEqual(["cap-A"]);
    expect(driver.events).toContain("stop s1 pressure");
    expect(driver.running).toEqual(["s2"]);
    // The parked session left the registry: its next turn is routed afresh.
    await until(async () => (await registry.lookup("s1")) === null, 5_000);
  }, 30_000);

  test("a warm session's turn runs on a full node, on its existing sandbox", async () => {
    const { driver } = nodes["cap-A"]!;
    await until(async () => (await registry.lookup("s2"))?.node === "cap-A", 5_000);
    // The report rides the heartbeat, a second behind.
    await until(async () => (await registry.nodeBoxes("cap-A"))?.running === 1, 5_000);
    await turns.enqueueTurn(job("s2"), { node: "cap-A" });
    await until(() => (ran.get("s2") ?? []).length === 2, 10_000);
    expect(ran.get("s2")).toEqual(["cap-A", "cap-A"]);
    expect(created(driver, "s2")).toBe(1);
    expect(driver.running).toEqual(["s2"]);
  }, 20_000);

  test("with none idle the node hands the job back and pauses its label queue; a second node claims it and it runs once", async () => {
    // The periodic check may have paused the label queue while an earlier turn was in flight (it does on a slow
    // machine), and a paused worker claims nothing until room has held for 5 s. A hand-back needs a claim, so
    // start from a label worker that is waiting for a job: that wait is not cancelled by a pause, it takes the
    // next job and only then stops.
    await until(async () => pausedForRoom() === 0 && (await labelWorkersWaiting()) >= 1, 20_000);
    const before = handedBack();
    // s2's next turn stays in flight: the node is full and has nothing it may park.
    hold("s2");
    await turns.enqueueTurn(job("s2"), { node: "cap-A" });
    await until(() => nodes["cap-A"]!.agent.inTurn.has("s2"), 10_000);
    await turns.enqueueTurn(job("s3"), { label: "default" });
    // cap-A is the only node: it claims s3, finds no room, puts it back and stops claiming from the label queue.
    // One other order is correct and rare: the check pauses the label queue first and the worker's wait ends
    // on its own before s3 arrives, so s3 is never claimed here. Either way the queue is paused and s3 waits.
    await until(() => handedBack() > before || pausedForRoom() === 1, 10_000);
    await until(() => pausedForRoom() === 1, 5_000);
    await until(async () => (await registry.nodeBoxes("cap-A"))?.free === 0, 5_000);
    expect(ran.get("s3")).toBeUndefined();
    expect(created(nodes["cap-A"]!.driver, "s3")).toBe(0);
    // A second node comes up and takes it from the label queue.
    await startNode("cap-B", 0);
    await until(() => (ran.get("s3") ?? []).length === 1, 15_000);
    expect(ran.get("s3")).toEqual(["cap-B"]);
    expect(nodes["cap-B"]!.driver.running).toEqual(["s3"]);
    // Not run twice, and never on the full node.
    await sleep(1_500);
    expect(ran.get("s3")).toEqual(["cap-B"]);
    expect(created(nodes["cap-A"]!.driver, "s3")).toBe(0);
  }, 45_000);

  test("a job routed to a full node's own queue comes back to the label queue and runs once", async () => {
    const before = handedBack();
    // cap-A is still full with s2's turn in flight. A cold session is routed straight to its own queue.
    await turns.enqueueTurn(job("s4"), { node: "cap-A" });
    await until(() => handedBack() > before, 10_000);
    // The other node parks its idle session and runs it.
    await until(() => (ran.get("s4") ?? []).length === 1, 15_000);
    expect(ran.get("s4")).toEqual(["cap-B"]);
    expect(created(nodes["cap-A"]!.driver, "s4")).toBe(0);
    await sleep(1_500);
    expect(ran.get("s4")).toEqual(["cap-B"]);
    // The own queue's copy completed as moved, not as a failure.
    const counts = await turns.queue(nodeQueue("cap-A")).getJobCounts("failed");
    expect(counts.failed ?? 0).toBe(0);
    // The held turn ends normally.
    holds.get("s2")!.release();
    await until(() => !nodes["cap-A"]!.agent.inTurn.has("s2"), 10_000);
    expect(ran.get("s2")).toEqual(["cap-A", "cap-A", "cap-A"]);
  }, 45_000);

  test("a full node that gets room back resumes its label queue after the hold", async () => {
    // s2 is idle now and this node parks idle sessions at once: a new session is admitted by making room.
    await until(async () => ((await registry.nodeBoxes("cap-A"))?.free ?? 0) >= 0, 5_000);
    await nodes["cap-B"]!.worker.stop({ drainSec: 1 });
    delete nodes["cap-B"];
    await turns.enqueueTurn(job("s5"), { label: "default" });
    // Its label queue was paused for capacity; it resumes once room has held (5 s), then claims s5.
    await until(() => (ran.get("s5") ?? []).length === 1, 25_000);
    expect(ran.get("s5")).toEqual(["cap-A"]);
  }, 45_000);

  test("drain stops every warm box before the worker exits, and its report is gone", async () => {
    const { worker, driver } = nodes["cap-A"]!;
    expect(driver.running.length).toBe(1);
    await worker.stop({ drainSec: 2 });
    delete nodes["cap-A"];
    expect(driver.running).toEqual([]);
    expect(driver.events.some((e: string) => e.endsWith(" drain"))).toBe(true);
    expect(await registry.nodeBoxes("cap-A")).toBeNull();
    expect(await registry.nodeCaps("cap-A")).toEqual(new Set());
  }, 30_000);
});
