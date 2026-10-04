/**
 * Reaper H27 (node labels spec §4.6 "Reaper"), real Redis, gated: a dead
 * node's own queue is drained onto each job's LABEL queue, and an ACTIVE job
 * whose BullMQ lock has expired — a warm-routed turn the node had claimed when
 * it died — is recovered exactly once. An active job whose lock is live is
 * never touched, and its node stays on the work list until it is.
 *
 * The "node" here is a bare BullMQ worker claiming manually (getNextJob): its
 * lock is never renewed, exactly like a killed process.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sweepTag, testPrefix, until } from "./real";
import type { Keys } from "../../src/queue/keys";
import type { Registry } from "../../src/queue/registry";
import type { Reaper } from "../../src/queue/reaper";
import type { TurnJob, TurnQueues } from "../../src/queue/turns";

const prefix = testPrefix("reaperact");

let seq = 0;
function turn(sessionId: string, text: string, label?: string): TurnJob {
  return {
    sessionId,
    tenantId: "t_1",
    personaId: "p_1",
    ...(label ? { label } : {}),
    messages: [{ ts: `1700000100.${String(++seq).padStart(6, "0")}`, user: "U1", text }],
    jobToken: "tok",
    enqueuedAt: Date.now(),
  };
}

describe.skipIf(!realEnabled)("queue/reaper rescues active jobs of dead nodes (real Redis)", () => {
  let redis: Redis;
  let keys: Keys;
  let queues: TurnQueues;
  let registry: Registry;
  let reaper: Reaper;
  const workers: Worker[] = [];
  const conns: Redis[] = [];

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues: TQ } = await import("../../src/queue/turns");
    const { makeRegistry } = await import("../../src/queue/registry");
    const { makeReaper } = await import("../../src/queue/reaper");
    redis = realRedis();
    conns.push(redis);
    await sweepTag(redis, "reaperact");
    keys = makeKeys(prefix);
    queues = new TQ({ connection: redis, keys });
    registry = makeRegistry({ redis, keys, heartbeatSec: 30, nodeTtlSec: 0.25 });
    reaper = makeReaper({ redis, keys, turns: queues, registry });
  })();

  const worker = (qname: string, proc: ((job: Job) => Promise<unknown>) | null, o: Record<string, unknown> = {}): Worker => {
    const conn = realRedis();
    conns.push(conn);
    const w = new Worker(qname, proc, { connection: conn, prefix: keys.bullPrefix, ...o });
    workers.push(w);
    return w;
  };
  const lockGone = (queue: string, id: string) => async () =>
    (await redis.exists(`${keys.bullPrefix}:${queue}:${id}:lock`)) === 0;

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
  });

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await queues.close();
    await cleanupPrefix(redis, prefix);
    await Promise.all(conns.splice(0).map((c) => c.quit().catch(() => {})));
  });

  test("a dead node's claimed turn (lock expired) is recovered exactly once and runs on a live worker of its label", async () => {
    await ready;
    // Node A runs a warm-routed engineering turn and dies mid-turn.
    await registry.nodeUp("dead-a", ["engineering"]);
    await registry.register("s-act", "dead-a");
    await queues.enqueueTurn(turn("s-act", "mid-turn", "engineering"), { node: "dead-a" }, "act-1");
    const nodeA = worker("turns.dead-a", null, { autorun: false, lockDuration: 300 });
    expect((await nodeA.getNextJob("tok-a"))!.id).toBe("act-1");
    // Node B is alive with its own claimed turn, lock renewed by its worker.
    const beat = setInterval(() => void registry.beatNode("live-b", ["engineering"]), 50);
    await registry.nodeUp("live-b", ["engineering"]);
    await queues.enqueueTurn(turn("s-live", "busy", "engineering"), { node: "live-b" }, "act-live");
    let releaseB!: () => void;
    const holdB = new Promise<void>((r) => (releaseB = r));
    const nodeB = worker("turns.live-b", async () => holdB, { lockDuration: 300 });
    await until(async () => (await queues.queue("turns.live-b").getActiveCount()) === 1, 5000);

    await until(async () => !(await registry.nodeAlive("dead-a")), 2000);
    await until(lockGone("turns.dead-a", "act-1"), 5000);

    // A live worker of the label picks the rescued turn up.
    const ran: string[] = [];
    worker("turns.label.engineering", async (job) => {
      ran.push(...(job.data as TurnJob).messages.map((m) => m.text));
    });

    const report = await reaper.reapDeadNodes();
    expect(report.deadNodes).toEqual(["dead-a"]);
    expect(report.jobsMoved).toBe(1);
    expect(report.sessionsCleared).toBe(1);
    // Same id on the label queue; a follower follows the marker there.
    expect(await queues.movedTo("act-1")).toEqual({ queue: "turns.label.engineering", jobId: "act-1" });
    expect(await queues.queue("turns.dead-a").getActiveCount()).toBe(0);
    await until(() => ran.length === 1, 5000);
    // Another pass finds nothing: exactly once.
    const again = await reaper.reapDeadNodes();
    expect(again.jobsMoved).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toEqual(["mid-turn"]);
    // The live node's claimed job was not touched.
    expect(await queues.queue("turns.live-b").getActiveCount()).toBe(1);
    expect(await registry.knownNodes()).toEqual(["live-b"]);
    releaseB();
    clearInterval(beat);
    void nodeB;
    await registry.nodeDown("live-b");
    for (const s of ["s-act", "s-live"]) await redis.del(keys.coalesce(s));
  });

  test("an active job whose lock is still live is left alone, and its node is looked at again next pass", async () => {
    await ready;
    await registry.nodeUp("part-c", ["default"]);
    await queues.enqueueTurn(turn("s-part", "partitioned"), { node: "part-c" }, "part-1");
    const nodeC = worker("turns.part-c", null, { autorun: false, lockDuration: 1500 });
    const claimed = (await nodeC.getNextJob("tok-c"))!;
    await until(async () => !(await registry.nodeAlive("part-c")), 2000);
    // Heartbeat gone but the lock is live: a partitioned process may still run it.
    const first = await reaper.reapDeadNodes();
    expect(first.jobsMoved).toBe(0);
    expect(await queues.queue("turns.part-c").getActiveCount()).toBe(1);
    expect(await registry.knownNodes()).toContain("part-c");
    // The lock lapses: the next pass rescues it onto `turns` (label default).
    await until(lockGone("turns.part-c", "part-1"), 5000);
    const second = await reaper.reapDeadNodes();
    expect(second.jobsMoved).toBe(1);
    expect(await registry.knownNodes()).not.toContain("part-c");
    const moved = await queues.queue("turns").getJob("part-1");
    expect((moved!.data as TurnJob).messages.map((m) => m.text)).toEqual(["partitioned"]);
    void claimed;
    await moved!.remove();
    await redis.del(keys.coalesce("s-part"));
  });

  test("waiting jobs of a dead node go to their own label's queue, not to turns", async () => {
    await ready;
    await registry.nodeUp("dead-d", ["finance"]);
    await queues.enqueueTurn(turn("s-fin", "fin", "finance"), { node: "dead-d" }, "fin-1");
    await queues.enqueueTurn(turn("s-def", "def"), { node: "dead-d" }, "def-1");
    await until(async () => !(await registry.nodeAlive("dead-d")), 2000);
    const report = await reaper.reapDeadNodes();
    expect(report.jobsMoved).toBe(2);
    expect(await queues.queue("turns.label.finance").getJob("fin-1")).toBeTruthy();
    expect(await queues.queue("turns").getJob("def-1")).toBeTruthy();
    expect(await queues.movedTo("fin-1")).toEqual({ queue: "turns.label.finance", jobId: "fin-1" });
    await queues.queue("turns.label.finance").remove("fin-1");
    await queues.queue("turns").remove("def-1");
    for (const s of ["s-fin", "s-def"]) await redis.del(keys.coalesce(s));
  });
});
