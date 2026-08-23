/**
 * Scenario: kill AFTER the reply — the zombie double-post window.
 *
 * The victim node completes its agent turn (reply posted, turn-done marker
 * written) and is SIGKILLed inside the ack window, before BullMQ records the
 * job as completed (the afterTurn test seam parks the processor there). The
 * stalled-job retry lands on the survivor, which finds the turn-done marker
 * and completes the job WITHOUT re-running the turn — exactly one reply
 * reaches Slack.
 *
 * Residual at-least-once window (documented in multi-node.md): a node dying
 * between its last Slack post and the marker write still replays the turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  sleep,
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

const CH = "D0ZOMBIE";
const TS = "8600.1";

let redis: any;
let keys: any;
let gw: Replica;
let nodes: Array<{ agent: any; worker: any }> = [];
let metricsRender: () => string;

/** Swappable post-turn hook shared by both workers (set once the test knows
 *  which node claimed). */
let afterTurnHook: ((jobId: string, outcome: string) => Promise<void>) | undefined;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { metrics } = await import("../../src/metrics");
  const { Redis } = await import("ioredis");
  metricsRender = () => metrics.render();
  keys = makeKeys(testPrefix("zombie"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  gw = await bootReplica(keys);
  const worker = {
    bull: { lockDuration: 1500, stalledInterval: 500 },
    hooks: { afterTurn: async (jobId: string, outcome: string) => afterTurnHook?.(jobId, outcome) },
  };
  nodes = [
    await bootNode(keys, gw.url, { nodeId: "scen-zd-A", worker }),
    await bootNode(keys, gw.url, { nodeId: "scen-zd-B", worker }),
  ];
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const n of nodes) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

const dedupedCount = () =>
  Number(metricsRender().match(/slaude_node_turns_total\{result="deduped"\} (\d+)/)?.[1] ?? 0);

d("kill after reply → retry finds the turn-done marker (real Redis)", () => {
  test("victim replies + dies pre-ack; survivor completes the job without a second reply", async () => {
    // Both stubs reply and record who ran; the shared afterTurn hook then
    // SIGKILLs whoever ran and parks its processor forever — the reply and
    // marker are out, the BullMQ ack never happens.
    const ran: Array<{ agent: any; worker: any }> = [];
    for (const n of nodes) {
      n.agent.run = async ({ ctx }: any) => {
        ran.push(n);
        await ctx.surface.reply({ text: `zd-reply via=${n.worker.nodeId}` });
      };
    }
    afterTurnHook = async () => {
      ran[0]!.worker.kill();
      await new Promise(() => {}); // die inside the ack window
    };

    const dedupedBefore = dedupedCount();
    await gw.transport.feedMessage(dm(CH, TS, "reply then die"));

    // The victim's reply landed (turn completed) …
    await until(() => replies(gw.transport, "zd-reply").length >= 1, 20_000);
    expect(ran.length).toBe(1);
    const survivor = nodes.find((n) => n !== ran[0])!;

    // … and its turn-done marker is durable in Redis.
    await until(async () => (await redis.keys(`${keys.prefix}:turn-done:*`)).length === 1, 10_000);

    // Stall recovery re-delivers the un-acked job to the survivor, which
    // dedups on the marker instead of running the agent.
    await until(() => dedupedCount() > dedupedBefore, 25_000);

    // Hard negative window: nothing may double-post after the dedup.
    await sleep(500);
    expect(replies(gw.transport, "zd-reply").length).toBe(1);
    expect(replies(gw.transport, "zd-reply")[0]!.text).toContain(ran[0]!.worker.nodeId);
    expect(ran.length).toBe(1); // the survivor's agent never ran
    expect(survivor.worker.state()).toBe("ready"); // and it stayed healthy
  }, 60_000);
});
