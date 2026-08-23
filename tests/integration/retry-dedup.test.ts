/**
 * Scenario (spec §8): Slack retry dedup across gateway replicas.
 *
 * Slack redelivers an event envelope (X-Slack-Retry-Num > 0) when it doubts
 * the ack — and behind a load balancer the retry can land on a DIFFERENT
 * replica. The durable seen_events claim (shared DB) must make exactly one
 * replica dispatch the turn: same envelope fed to replica 1 and replica 2 →
 * one dispatch, one node turn, one reply.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  cleanupPrefix,
  setupScenarioEnv,
  teardownScenarioEnv,
  bootReplica,
  bootNode,
  dm,
  replies,
  REAL_URL,
  testPrefix,
  type Replica,
} from "./harness";

const d = describe.skipIf(!realEnabled);

const CH = "D0RETRYDUP";
const TS = "8500.1";

let redis: any;
let keys: any;
let gw1: Replica;
let gw2: Replica;
let node: { agent: any; worker: any };
let turnsRan = 0;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { Redis } = await import("ioredis");
  keys = makeKeys(testPrefix("retrydup"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  gw1 = await bootReplica(keys);
  gw2 = await bootReplica(keys);
  node = await bootNode(keys, gw1.url, { nodeId: "scen-dedup" });
  node.agent.run = async ({ ctx }: any) => {
    turnsRan++;
    await ctx.surface.reply({ text: "dedup-reply" });
  };
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw1?.stop().catch(() => {});
  await gw2?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

d("Slack retry dedup across replicas (real Redis)", () => {
  test("same envelope on two replicas → exactly one turn", async () => {
    const { metrics } = await import("../../src/metrics");
    const dedupDrops = () =>
      Number(metrics.render().match(/slaude_slack_drops_total\{reason="dedup"\} (\d+)/)?.[1] ?? 0);
    const dropsBefore = dedupDrops();

    // Original delivery to replica 1; Slack's retry of the SAME envelope
    // (identical channel + ts) lands on replica 2.
    const envelope = dm(CH, TS, "handle this exactly once");
    await gw1.transport.feedMessage(envelope);
    await gw2.transport.feedMessage(envelope);

    // One replica claimed the (channel, ts) in seen_events; the other dropped.
    expect(gw1.dispatches() + gw2.dispatches()).toBe(1);
    expect(dedupDrops()).toBe(dropsBefore + 1);

    // Exactly one node turn, one reply — on the replica that won the claim.
    await until(() => replies(gw1.transport, "dedup-reply").length >= 1, 20_000);
    expect(turnsRan).toBe(1);
    expect(replies(gw1.transport, "dedup-reply").length).toBe(1);
    expect(replies(gw2.transport, "dedup-reply").length).toBe(0);

    // Still exactly one after the turn settled (no late duplicate).
    await new Promise((r) => setTimeout(r, 500));
    expect(turnsRan).toBe(1);
    expect(replies(gw1.transport, "dedup-reply").length).toBe(1);
  }, 40_000);
});
