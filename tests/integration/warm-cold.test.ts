/**
 * Scenario (spec §8): warm on node A, then cold resume on node B.
 *
 * Turn 1 lands on some node via the shared queue and the session goes warm
 * there; turn 2 rides that node's per-node queue (warm routing). Then the
 * warm node's worker is stopped (its registration is dropped), and the next
 * message routes to the shared queue where the surviving node cold-resumes:
 * the SAME session row answers, warm state on a node is disposable.
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

const CH = "D0WARMCOLD";
const T1 = "8100.1";

let redis: any;
let keys: any;
let registry: any;
let turnsQ: any;
let gw: Replica;
let nodes: Array<{ agent: any; worker: any }> = [];
let sessions: any;
let nodeTurnsQueueFn: any;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys, nodeTurnsQueue } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");
  nodeTurnsQueueFn = nodeTurnsQueue;

  keys = makeKeys(testPrefix("warmcold"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  turnsQ = new TurnQueues({ connection: redis, keys });

  gw = await bootReplica(keys);
  nodes = [
    await bootNode(keys, gw.url, { nodeId: "scen-wc-A" }),
    await bootNode(keys, gw.url, { nodeId: "scen-wc-B" }),
  ];
  nodes[0]!.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "wc-reply via=scen-wc-A" });
  nodes[1]!.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "wc-reply via=scen-wc-B" });
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const n of nodes) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  await turnsQ?.close().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

const viaOf = (text: string) => text.match(/via=(\S+)/)?.[1];

d("warm-then-cold across two nodes (real Redis)", () => {
  let sessionId: string;
  let warmNodeId: string;
  let warm: { agent: any; worker: any };
  let survivor: { agent: any; worker: any };

  test("turn 1: shared queue, session goes warm on the claiming node", async () => {
    await gw.transport.feedMessage(dm(CH, T1, "first turn"));
    await until(() => replies(gw.transport, "wc-reply").length >= 1, 20_000);
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    expect(row).not.toBeNull();
    sessionId = row!.id;
    await until(async () => (await registry.lookup(sessionId)) !== null, 10_000);
    warmNodeId = (await registry.lookup(sessionId))!.node;
    expect(viaOf(replies(gw.transport, "wc-reply")[0]!.text)).toBe(warmNodeId);
    warm = nodes.find((n) => n.worker.nodeId === warmNodeId)!;
    survivor = nodes.find((n) => n.worker.nodeId !== warmNodeId)!;
  }, 30_000);

  test("turn 2: warm routing rides the per-node queue of the same node", async () => {
    await gw.transport.feedMessage({ ...dm(CH, "8100.2", "warm follow-up"), thread_ts: T1 });
    await until(() => replies(gw.transport, "wc-reply").length >= 2, 20_000);
    expect(viaOf(replies(gw.transport, "wc-reply")[1]!.text)).toBe(warmNodeId);
    const counts = await turnsQ.queue(nodeTurnsQueueFn(warmNodeId)).getJobCounts("completed");
    expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("kill the warm node: registration gone, next message cold-resumes on the survivor", async () => {
    const row1 = await sessions.findById(sessionId);
    await warm.worker.stop({ drainSec: 2 });
    expect(await registry.lookup(sessionId)).toBeNull();

    const sharedBefore = (await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0;
    await gw.transport.feedMessage({ ...dm(CH, "8100.3", "resume me"), thread_ts: T1 });
    await until(() => replies(gw.transport, "wc-reply").length >= 3, 20_000);

    // The survivor answered, via the shared queue.
    expect(viaOf(replies(gw.transport, "wc-reply")[2]!.text)).toBe(survivor.worker.nodeId);
    const sharedAfter = (await turnsQ.queue("turns").getJobCounts("completed")).completed ?? 0;
    expect(sharedAfter).toBeGreaterThan(sharedBefore);

    // Session continuity: same row, same workspace dir — the thread's session
    // survived its node.
    const row2 = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    expect(row2!.id).toBe(sessionId);
    expect(row2!.working_dir).toBe(row1!.working_dir);
  }, 40_000);
});
