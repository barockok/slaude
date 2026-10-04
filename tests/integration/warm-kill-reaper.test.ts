/**
 * Scenario (node labels spec §4.6 "Reaper", H27): a node is killed during a
 * WARM-routed turn. The job sits active on the dead node's own queue, which no
 * surviving worker consumes, so BullMQ's stall recovery never sees it. The
 * reaper moves it (its lock has expired) to its label's queue; the surviving
 * node runs it, and the user gets exactly one reply.
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

const CH = "D0WARMKILL";
const T1 = "8800.1";

let redis: any;
let keys: any;
let registry: any;
let reaper: any;
let turns: any;
let gw: Replica;
let nodes: Record<string, { agent: any; worker: any }> = {};
let sessions: any;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makeReaper } = await import("../../src/queue/reaper");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");
  keys = makeKeys(testPrefix("warmkill"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  registry = makeRegistry({ redis, keys, heartbeatSec: 1, nodeTtlSec: 3 });
  turns = new TurnQueues({ connection: redis, keys });
  reaper = makeReaper({ redis, keys, turns, registry });
  gw = await bootReplica(keys);
  const bull = { lockDuration: 1500, stalledInterval: 500 };
  for (const id of ["scen-wk-A", "scen-wk-B"]) {
    nodes[id] = await bootNode(keys, gw.url, { nodeId: id, worker: { bull, lock: { ttlMs: 3_000, extendEveryMs: 1_000 } } });
    nodes[id]!.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: `wk-reply via=${id}` });
  }
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const n of Object.values(nodes)) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await turns?.close().catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

d("node killed during a warm-routed turn → the reaper recovers it (real Redis)", () => {
  test("the claimed job on the dead node's own queue runs exactly once on the survivor", async () => {
    await gw.transport.feedMessage(dm(CH, T1, "warm me up"));
    await until(() => replies(gw.transport, "wk-reply").length >= 1, 20_000);
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    await until(async () => !!(await registry.lookup(row!.id)), 10_000);
    const victimId = (await registry.lookup(row!.id)).node as string;
    const survivorId = Object.keys(nodes).find((id) => id !== victimId)!;
    const victim = nodes[victimId]!;

    // The next turn is warm-routed to the victim's own queue, which it claims
    // and never finishes.
    let claimed = false;
    victim.agent.run = async () => {
      claimed = true;
      await new Promise(() => {});
    };
    await gw.transport.feedMessage({ ...dm(CH, "8800.2", "long task"), thread_ts: T1 });
    await until(() => claimed, 15_000);
    const nodeQueue = turns.queue(`turns.${victimId}`);
    expect(await nodeQueue.getActiveCount()).toBe(1);

    victim.worker.kill();
    // Heartbeat and the job lock lapse; the reaper (any leader pass) recovers it.
    await until(async () => {
      await reaper.reapDeadNodes();
      return (await nodeQueue.getActiveCount()) === 0;
    }, 20_000, 250);

    await until(() => replies(gw.transport, "wk-reply").length >= 2, 30_000);
    await new Promise((r) => setTimeout(r, 1500)); // room for a duplicate
    const all = replies(gw.transport, "wk-reply");
    expect(all).toHaveLength(2);
    expect(all[1]!.text).toContain(`via=${survivorId}`);
    // Another pass finds nothing to move.
    expect((await reaper.reapDeadNodes()).jobsMoved).toBe(0);
  }, 90_000);
});
