/**
 * Scenario (spec §8): three rapid messages coalesce into one turn.
 *
 * Part 1 — no worker yet: three messages for one session land as ONE pending
 * BullMQ job whose messages[] holds all three; a late-booting node runs a
 * single turn whose prompt carries all three texts.
 *
 * Part 2 — turn active: a message claims a fresh job and hangs mid-turn; two
 * more messages arrive and coalesce into ONE follow-up job (never appended to
 * the active job); releasing the first turn lets the second run with exactly
 * the remaining two messages.
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

const CH = "D0COALESCE";
const T1 = "8400.1";

let redis: any;
let keys: any;
let turnsQ: any;
let gw: Replica;
let node: { agent: any; worker: any } | undefined;
let sessions: any;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");
  keys = makeKeys(testPrefix("coalesce"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  turnsQ = new TurnQueues({ connection: redis, keys });
  gw = await bootReplica(keys);
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  await turnsQ?.close().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

d("message coalescing through the queue (real Redis)", () => {
  test("three messages, no claim yet → one job carrying all three; one turn runs", async () => {
    await gw.transport.feedMessage(dm(CH, T1, "part one"));
    await gw.transport.feedMessage({ ...dm(CH, "8400.2", "part two"), thread_ts: T1 });
    await gw.transport.feedMessage({ ...dm(CH, "8400.3", "part three"), thread_ts: T1 });
    expect(gw.dispatches()).toBe(3);

    // One pending job for the session, messages[] = all three.
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    const ref = JSON.parse((await redis.get(keys.coalesce(row!.id)))!);
    const job = await turnsQ.queue(ref.queue).getJob(ref.jobId);
    expect(job.data.messages.length).toBe(3);
    expect((await turnsQ.queue("turns").getJobCounts("waiting")).waiting ?? 0).toBe(1);

    // Late worker: the single coalesced job runs as ONE turn seeing all three.
    const envelopes: string[] = [];
    node = await bootNode(keys, gw.url, { nodeId: "scen-coal" });
    node.agent.run = async ({ envelope, ctx }: any) => {
      envelopes.push(envelope);
      await ctx.surface.reply({ text: "coal-reply-1" });
    };
    await until(() => replies(gw.transport, "coal-reply-1").length >= 1, 20_000);
    expect(envelopes.length).toBe(1);
    for (const part of ["part one", "part two", "part three"]) expect(envelopes[0]!).toContain(part);
  }, 40_000);

  test("turn active → follow-up job; second turn sees exactly the remaining messages", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const envelopes: string[] = [];
    node!.agent.run = async ({ envelope, ctx }: any) => {
      envelopes.push(envelope);
      if (envelopes.length === 1) await gate; // first turn hangs mid-turn
      await ctx.surface.reply({ text: `coal-reply-turn${envelopes.length}` });
    };

    await gw.transport.feedMessage({ ...dm(CH, "8400.4", "part four"), thread_ts: T1 });
    await until(() => envelopes.length >= 1, 15_000); // claimed → turn active

    // Two more while active: they must coalesce into ONE follow-up job.
    await gw.transport.feedMessage({ ...dm(CH, "8400.5", "part five"), thread_ts: T1 });
    await gw.transport.feedMessage({ ...dm(CH, "8400.6", "part six"), thread_ts: T1 });
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    const ref = JSON.parse((await redis.get(keys.coalesce(row!.id)))!);
    const followUp = await turnsQ.queue(ref.queue).getJob(ref.jobId);
    expect(followUp.data.messages.map((m: any) => m.text).join(" ")).toContain("part five");
    expect(followUp.data.messages.length).toBe(2);

    release();
    await until(() => replies(gw.transport, "coal-reply-turn2").length >= 1, 20_000);
    expect(envelopes.length).toBe(2);
    expect(envelopes[0]!).toContain("part four");
    expect(envelopes[0]!).not.toContain("part five");
    expect(envelopes[1]!).toContain("part five");
    expect(envelopes[1]!).toContain("part six");
    expect(envelopes[1]!).not.toContain("part four");
  }, 40_000);
});
