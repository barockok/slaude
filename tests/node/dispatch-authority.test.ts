/**
 * Dispatch-side guarantees (real Redis, gated):
 *
 *   - Job completion is the AUTHORITATIVE turn outcome: when a job settles
 *     and the events stream never delivered done/error (trim gap, node crash
 *     between emit and append), the follower synthesizes the outcome so the
 *     Slack UX pipeline still closes the turn. When the stream DOES deliver,
 *     nothing is synthesized (exactly one outcome).
 *   - A fresh user message supersedes a lingering abort: dispatch GETDELs the
 *     durable abort flag before enqueueing, so an /abort that no node ever
 *     consumed (all nodes down) cannot silently kill the next turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const d = describe.skipIf(!realEnabled);

let redis: any;
let keys: any;
let qd: any;
let pubsub: any;
let agent: any;
let events: any[] = [];
let workers: any[] = [];
let workerMode: "silent-complete" | "fail" | "stream-done" = "silent-complete";

const sessionRow = (id: string): any => ({ id, model: "m", working_dir: "/tmp", status: "idle" });
const meta = { teamId: "T", channelId: "C1", threadTs: "1.0", eventTs: "1.1", userId: "U1" };

beforeAll(async () => {
  if (!realEnabled) return;
  process.env.SLAUDE_JOB_SECRET = "dispatch-authority-secret";
  const { AgentManager } = await import("../../src/agent/manager");
  const { makeQueueDispatch } = await import("../../src/gateway/core/dispatch");
  const { makeKeys } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { TurnQueues } = await import("../../src/queue/turns");
  const { Worker } = await import("bullmq");
  const { Redis } = await import("ioredis");

  keys = makeKeys(testPrefix("dauth"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "dauth"); // interrupted-run leftovers
  const sub = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const turns = new TurnQueues({ connection: redis, keys });
  const registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  pubsub = makePubSub({ redis, sub, keys });
  agent = new AgentManager();
  agent.on("event", (e: any) => events.push(e));
  qd = makeQueueDispatch(agent, {
    keys,
    followPollMs: 50,
    followLingerMs: 200,
    infra: { turns, registry, pubsub },
  });

  // A "node" that claims jobs but whose stream behavior is scripted per test.
  const processor = async (job: any) => {
    const sessionId = (job.data as any).sessionId;
    if (workerMode === "fail") throw new Error("scripted failure");
    if (workerMode === "stream-done") {
      await pubsub.appendEvent(sessionId, { type: "assistantText", sessionId, text: "hi" });
      await pubsub.appendEvent(sessionId, { type: "done", sessionId });
    }
    // silent-complete: settle the job with NOTHING on the stream.
    return {};
  };
  workers = [new Worker("turns", processor, { connection: new Redis(REAL_URL, { maxRetriesPerRequest: null }), prefix: keys.bullPrefix, concurrency: 2 })];
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const w of workers) await w.close(true).catch(() => {});
  await qd?.close().catch(() => {});
  if (redis) await obliterateQueues(redis, keys.bullPrefix, ["turns"]);
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_JOB_SECRET;
});

d("dispatch follower: job completion is the authoritative outcome", () => {
  test("silent job completion synthesizes a done for the UX pipeline", async () => {
    events.length = 0;
    workerMode = "silent-complete";
    await qd.dispatch(sessionRow("s-silent"), "hello", meta);
    await until(() => events.some((e) => e.type === "done" && e.sessionId === "s-silent"), 10_000);
  }, 20_000);

  test("stream-delivered done is NOT duplicated by the authority check", async () => {
    events.length = 0;
    workerMode = "stream-done";
    await qd.dispatch(sessionRow("s-stream"), "hello", meta);
    await until(() => events.some((e) => e.type === "done" && e.sessionId === "s-stream"), 10_000);
    await sleep(600); // let the authority check observe the settled job
    expect(events.filter((e) => e.type === "done" && e.sessionId === "s-stream").length).toBe(1);
    // The stream's other events flowed through too.
    expect(events.some((e) => e.type === "assistantText" && e.sessionId === "s-stream")).toBe(true);
  }, 20_000);

  test("failed job synthesizes an error", async () => {
    events.length = 0;
    workerMode = "fail";
    await qd.dispatch(sessionRow("s-fail"), "hello", meta);
    // attempts=2 with 1s backoff — the final failure lands after the retry.
    await until(() => events.some((e) => e.type === "error" && e.sessionId === "s-fail"), 15_000);
  }, 25_000);
});

d("dispatch clears a lingering abort flag", () => {
  test("an unconsumed /abort does not kill the next user turn", async () => {
    events.length = 0;
    workerMode = "silent-complete";
    // /abort with all nodes down: durable flag set, nobody subscribed.
    await pubsub.publishAbort("s-superseded");
    expect(await redis.get(keys.abortFlag("s-superseded"))).toBe("1");
    // A fresh user message supersedes it…
    await qd.dispatch(sessionRow("s-superseded"), "new message", meta);
    expect(await redis.get(keys.abortFlag("s-superseded"))).toBeNull();
    // …and the turn runs to completion instead of being skipped at claim.
    await until(() => events.some((e) => e.type === "done" && e.sessionId === "s-superseded"), 10_000);
  }, 20_000);
});
