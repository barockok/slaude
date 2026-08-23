import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "./real";
import type { Keys } from "../../src/queue/keys";
import type { Registry } from "../../src/queue/registry";
import type { Reaper } from "../../src/queue/reaper";
import type { TurnJob, TurnQueues } from "../../src/queue/turns";

const prefix = testPrefix("reaper");

function turn(sessionId: string, text: string): TurnJob {
  return {
    sessionId,
    tenantId: "t_1",
    personaId: "p_1",
    messages: [{ ts: `${Date.now()}`, user: "U1", text }],
    jobToken: "tok",
    enqueuedAt: Date.now(),
  };
}

describe.skipIf(!realEnabled)("queue/reaper against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let queues: TurnQueues;
  let registry: Registry;
  let reaper: Reaper;
  let nodeQueueName: (nodeId: string) => string;

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys, nodeTurnsQueue } = await import("../../src/queue/keys");
    const { TurnQueues: TQ } = await import("../../src/queue/turns");
    const { makeRegistry } = await import("../../src/queue/registry");
    const { makeReaper } = await import("../../src/queue/reaper");
    redis = realRedis();
    keys = makeKeys(prefix);
    nodeQueueName = nodeTurnsQueue;
    queues = new TQ({ connection: redis, keys });
    registry = makeRegistry({ redis, keys, heartbeatSec: 30, nodeTtlSec: 0.25 });
    reaper = makeReaper({ redis, keys, turns: queues, registry });
  })();

  const sharedTexts = async () => {
    const jobs = await queues.queue("turns").getJobs(["waiting", "delayed", "prioritized"]);
    return jobs.flatMap((j) => (j.data as TurnJob).messages.map((m) => m.text)).sort();
  };

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await queues.close();
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("nothing dead → empty report", async () => {
    await ready;
    await registry.nodeUp("live-0");
    await registry.beatNode("live-0"); // fresh
    const report = await reaper.reapDeadNodes();
    expect(report).toEqual({ deadNodes: [], sessionsCleared: 0, jobsMoved: 0 });
    await registry.nodeDown("live-0");
  });

  test("dead node: sess entries cleared, per-node jobs move to shared; live node untouched", async () => {
    await ready;
    // dead node with two sessions + two parked jobs
    await registry.nodeUp("dead-1");
    await registry.register("s1", "dead-1");
    await registry.register("s2", "dead-1");
    await queues.enqueueTurn(turn("s1", "j1"), { node: "dead-1" });
    await queues.enqueueTurn(turn("s2", "j2"), { node: "dead-1" });
    // live node with its own session + job
    const beat = setInterval(() => void registry.beatNode("live-1"), 100);
    await registry.nodeUp("live-1");
    await registry.register("s4", "live-1");
    await queues.enqueueTurn(turn("s4", "j4"), { node: "live-1" });
    // a job already on shared, unrelated session
    await queues.enqueueTurn(turn("s3", "j3"), "shared");

    await until(async () => !(await registry.nodeAlive("dead-1")), 2000);
    const report = await reaper.reapDeadNodes();
    clearInterval(beat);

    expect(report.deadNodes).toEqual(["dead-1"]);
    expect(report.sessionsCleared).toBe(2);
    expect(report.jobsMoved).toBe(2);
    // dead node's registry leftovers are gone, live node's remain
    expect(await registry.lookup("s1")).toBeNull();
    expect(await registry.lookup("s2")).toBeNull();
    expect((await registry.lookup("s4"))!.node).toBe("live-1");
    expect(await registry.knownNodes()).toEqual(["live-1"]);
    // jobs: dead queue drained into shared, live queue untouched
    expect(await queues.queue(nodeQueueName("dead-1")).getWaitingCount()).toBe(0);
    expect(await queues.queue(nodeQueueName("live-1")).getWaitingCount()).toBe(1);
    expect(await sharedTexts()).toEqual(["j1", "j2", "j3"]);

    // cleanup for the next test
    await registry.nodeDown("live-1");
    await registry.unregister("s4");
    for (const q of ["turns", nodeQueueName("live-1")]) {
      for (const j of await queues.queue(q).getJobs(["waiting", "delayed"])) await j.remove();
    }
    for (const s of ["s1", "s2", "s3", "s4"]) await redis.del(keys.coalesce(s));
  });

  test("a node referenced only by sess entries (nodeset lost) is still reaped", async () => {
    await ready;
    await registry.register("s-ghost", "ghost-1"); // never nodeUp → not in nodeset
    const report = await reaper.reapDeadNodes();
    expect(report.deadNodes).toEqual(["ghost-1"]);
    expect(report.sessionsCleared).toBe(1);
    expect(await registry.lookup("s-ghost")).toBeNull();
  });

  test("moving a dead node's job coalesces into an existing pending shared job", async () => {
    await ready;
    await registry.nodeUp("dead-2");
    await queues.enqueueTurn(turn("s-merge", "on-node"), { node: "dead-2" });
    // decouple the index, then land a shared job for the same session
    await redis.del(keys.coalesce("s-merge"));
    const shared = await queues.enqueueTurn(turn("s-merge", "on-shared"), "shared");

    await until(async () => !(await registry.nodeAlive("dead-2")), 2000);
    const report = await reaper.reapDeadNodes();
    expect(report.jobsMoved).toBe(1);
    expect(await queues.queue(nodeQueueName("dead-2")).getWaitingCount()).toBe(0);
    // no third job: the node job's messages were appended onto the shared one
    const job = await queues.queue("turns").getJob(shared.jobId);
    expect((job!.data as TurnJob).messages.map((m) => m.text)).toEqual(["on-shared", "on-node"]);
    expect(await queues.queue("turns").getWaitingCount()).toBe(1);
    await job!.remove();
    await redis.del(keys.coalesce("s-merge"));
  });

  test("moveStalled: only jobs older than the threshold move", async () => {
    await ready;
    await queues.enqueueTurn(turn("s-old1", "old1"), { node: "busy-1" });
    await queues.enqueueTurn(turn("s-old2", "old2"), { node: "busy-1" });
    await sleep(120);
    await queues.enqueueTurn(turn("s-new", "new"), { node: "busy-1" });

    expect(await reaper.moveStalled("busy-1", 100)).toBe(2);
    expect(await queues.queue(nodeQueueName("busy-1")).getWaitingCount()).toBe(1);
    expect(await sharedTexts()).toEqual(["old1", "old2"]);
    // nothing else is past a huge threshold
    expect(await reaper.moveStalled("busy-1", 60_000)).toBe(0);
  });
});
