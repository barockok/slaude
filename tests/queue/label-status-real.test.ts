/**
 * Unserved labels (node labels spec §4.7), real Redis, gated: labels in use =
 * persona labels ∪ label queues in Redis; a label with waiting jobs and no
 * live node becomes unserved only past the threshold; the gauge follows, and
 * a label no longer in use loses its series. The leader and a panel replica
 * read the same since-time.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, obliterateQueues, realEnabled, realRedis, sweepTag, testPrefix } from "./real";

const prefix = testPrefix("lblstat");

describe.skipIf(!realEnabled)("label status against real Redis", () => {
  let redis: Redis;
  let turns: any;
  let keys: any;

  afterAll(async () => {
    if (!realEnabled) return;
    await turns?.close().catch(() => {});
    await obliterateQueues(redis, `${prefix}:bull`, ["turns", "turns.label.finance", "turns.label.ops"]);
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("waiting jobs and no live node past the threshold → unserved, gauge 1; served → 0; unused → series gone", async () => {
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues } = await import("../../src/queue/turns");
    const { makeRegistry } = await import("../../src/queue/registry");
    const { makeLabelMonitor } = await import("../../src/queue/label-status");
    const { metrics } = await import("../../src/metrics");
    redis = realRedis();
    await sweepTag(redis, "lblstat");
    keys = makeKeys(prefix);
    turns = new TurnQueues({ connection: redis, keys });
    const registry = makeRegistry({ redis, keys, heartbeatSec: 30 });
    let personaLabels = ["engineering"];
    const mon = makeLabelMonitor({ redis, keys, turns, registry, personaLabels: () => personaLabels, unservedSecs: () => 60 });
    const job = (sessionId: string, label: string) => ({
      sessionId, tenantId: "t", personaId: "p", label, messages: [{ ts: "1.1", user: "U1", text: "x" }], jobToken: "tok", enqueuedAt: Date.now(),
    });
    await turns.enqueueTurn(job("s-f1", "finance"), { label: "finance" });
    await turns.enqueueTurn(job("s-f2", "finance"), { label: "finance" });
    await registry.nodeUp("n-eng", ["engineering"]);

    // In use: default, a persona's engineering, and the finance queue.
    expect(await mon.inUse()).toEqual(["default", "engineering", "finance"]);

    const t0 = 1_000_000;
    const first = await mon.update(t0);
    const fin = first.find((s) => s.label === "finance")!;
    expect(fin).toEqual({ label: "finance", liveNodes: 0, waiting: 2, unserved: false, unservedSinceMs: t0 });
    expect(first.find((s) => s.label === "engineering")).toMatchObject({ liveNodes: 1, waiting: 0, unserved: false });
    const gauge = (l: string) => new RegExp(`slaude_label_unserved\\{label="${l}"\\} (\\d+)`).exec(metrics.render())?.[1];
    expect(gauge("finance")).toBe("0");

    // Past the threshold: unserved, on the leader and on a read-only replica.
    const later = t0 + 61_000;
    expect((await mon.update(later)).find((s) => s.label === "finance")!.unserved).toBe(true);
    expect(gauge("finance")).toBe("1");
    const replica = makeLabelMonitor({ redis, keys, turns, registry, personaLabels: () => personaLabels, unservedSecs: () => 60 });
    expect((await replica.read(later)).find((s) => s.label === "finance")).toMatchObject({ unserved: true, waiting: 2, liveNodes: 0 });

    // A node with the label comes up: served again, since-time cleared.
    await registry.nodeUp("n-fin", ["finance"]);
    expect((await mon.update(later + 1000)).find((s) => s.label === "finance")).toMatchObject({ unserved: false, unservedSinceMs: null, liveNodes: 1 });
    expect(gauge("finance")).toBe("0");
    expect(await redis.hget(keys.labelUnservedSince(), "finance")).toBeNull();

    // A label that leaves use loses its series.
    personaLabels = [];
    await mon.update(later + 2000);
    expect(gauge("engineering")).toBeUndefined();
    expect(gauge("finance")).toBe("0");

    // No live node and nothing waiting is not unserved.
    await registry.nodeDown("n-fin");
    for (const j of await turns.queue("turns.label.finance").getJobs(["waiting"])) await j.remove();
    await turns.enqueueTurn(job("s-o1", "ops"), { label: "ops" });
    for (const j of await turns.queue("turns.label.ops").getJobs(["waiting"])) await j.remove();
    const idle = await mon.update(later + 200_000);
    expect(idle.find((s) => s.label === "ops")).toMatchObject({ waiting: 0, liveNodes: 0, unserved: false });
    await registry.nodeDown("n-eng");
  }, 20_000);
});
