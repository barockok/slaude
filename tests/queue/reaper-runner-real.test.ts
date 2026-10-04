/**
 * The reaper leader's queue-depth gauge (node labels spec §4.7): one series per
 * label queue, `queue` unchanged (`turns` is still label default) and `label`
 * added. Real Redis, gated.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, obliterateQueues, realEnabled, realRedis, testPrefix, until } from "./real";

const prefix = testPrefix("rrunner");

describe.skipIf(!realEnabled)("reaper leader gauges against real Redis", () => {
  let redis: Redis;
  let stop: (() => Promise<void>) | null = null;
  let turns: any;

  afterAll(async () => {
    if (!realEnabled) return;
    await stop?.();
    await turns?.close().catch(() => {});
    await obliterateQueues(redis, `${prefix}:bull`, ["turns", "turns.label.finance"]);
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("slaude_queue_depth carries a series per label queue", async () => {
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues } = await import("../../src/queue/turns");
    const { startReaperLeader } = await import("../../src/queue/reaper-runner");
    const { metrics } = await import("../../src/metrics");
    redis = realRedis();
    const keys = makeKeys(prefix);
    turns = new TurnQueues({ connection: redis, keys });
    const job = (sessionId: string, label: string) => ({
      sessionId, tenantId: "t", personaId: "p", label, messages: [{ ts: "1.1", user: "U1", text: "x" }], jobToken: "tok", enqueuedAt: Date.now(),
    });
    await turns.enqueueTurn(job("s-g1", "finance"), { label: "finance" });
    await turns.enqueueTurn(job("s-g2", "finance"), { label: "finance" });
    await turns.enqueueTurn(job("s-g3", "default"), { label: "default" });
    const leader = startReaperLeader({ redis, keys, intervalMs: 60_000 });
    stop = () => leader.stop();
    // Labels render sorted: label before queue.
    const line = (q: string, l: string) => new RegExp(`slaude_queue_depth\\{label="${l}",queue="${q.replaceAll(".", "\\.")}"\\} (\\d+)`);
    await until(() => line("turns.label.finance", "finance").test(metrics.render()), 10_000);
    const text = metrics.render();
    expect(Number(line("turns.label.finance", "finance").exec(text)![1])).toBe(2);
    expect(Number(line("turns", "default").exec(text)![1])).toBe(1);
  }, 20_000);
});
