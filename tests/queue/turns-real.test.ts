import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, testPrefix, until } from "./real";
import type { TurnJob, TurnQueues, TurnQueuesOpts } from "../../src/queue/turns";
import type { Keys } from "../../src/queue/keys";

const prefix = testPrefix("turns");

function turn(sessionId: string, texts: string[], token = "tok"): TurnJob {
  return {
    sessionId,
    tenantId: "t_1",
    personaId: "p_1",
    messages: texts.map((text, i) => ({ ts: `${Date.now()}.${i}`, user: "U1", text })),
    jobToken: token,
    enqueuedAt: Date.now(),
  };
}

describe.skipIf(!realEnabled)("queue/turns against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let queues: TurnQueues;
  let mkQueues: (opts?: Partial<TurnQueuesOpts>) => TurnQueues;
  const extras: TurnQueues[] = [];
  const workers: Worker[] = [];
  const conns: Redis[] = [];

  // Dynamic imports: keep src/queue unloaded when this suite is skipped.
  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues: TQ } = await import("../../src/queue/turns");
    redis = realRedis();
    conns.push(redis);
    keys = makeKeys(prefix);
    mkQueues = (opts) => {
      const q = new TQ({ connection: redis, keys, ...opts });
      extras.push(q);
      return q;
    };
    queues = mkQueues();
  })();

  const startWorker = (qname: string, proc: (job: Job) => Promise<unknown>): Worker => {
    const conn = realRedis();
    conns.push(conn);
    const w = new Worker(qname, proc, { connection: conn, prefix: keys.bullPrefix });
    workers.push(w);
    return w;
  };

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
  });

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    for (const q of extras.splice(0)) await q.close();
    await cleanupPrefix(redis, prefix);
    await Promise.all(conns.splice(0).map((c) => c.quit().catch(() => {})));
  });

  test("enqueue → raw BullMQ worker claim roundtrip", async () => {
    await ready;
    const res = await queues.enqueueTurn(turn("s-round", ["hello"]), "shared");
    expect(res.coalesced).toBe(false);
    expect(res.queue).toBe("turns");

    let seen: TurnJob | null = null;
    const w = startWorker("turns", async (job) => {
      seen = job.data as TurnJob;
    });
    await new Promise((resolve, reject) => {
      w.on("completed", resolve);
      w.on("failed", (_j, err) => reject(err));
    });
    expect(seen!.sessionId).toBe("s-round");
    expect(seen!.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(seen!.jobToken).toBe("tok");
  });

  test("per-node target lands on the node's own queue", async () => {
    await ready;
    const res = await queues.enqueueTurn(turn("s-node", ["warm"]), { node: "nodeA" });
    expect(res.queue).toBe("turns.nodeA");
    expect(await queues.queue("turns.nodeA").getWaitingCount()).toBe(1);

    let seen: TurnJob | null = null;
    const w = startWorker("turns.nodeA", async (job) => {
      seen = job.data as TurnJob;
    });
    await new Promise((r) => w.on("completed", r));
    expect(seen!.messages[0]!.text).toBe("warm");
  });

  test("pending job coalesces: messages append, original token kept, still one job", async () => {
    await ready;
    const first = await queues.enqueueTurn(turn("s-coal", ["one"], "tok1"), "shared");
    const second = await queues.enqueueTurn(turn("s-coal", ["two", "three"], "tok2"), "shared");
    expect(second.coalesced).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    const job = await queues.queue("turns").getJob(first.jobId);
    const data = job!.data as TurnJob;
    expect(data.messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
    // The ORIGINAL job's token stays: its `job` claim must keep matching the
    // job id for /v1/jobs/:id/token-refresh; the worker refreshes an aging
    // token at claim time instead of relying on newest-message tokens.
    expect(data.jobToken).toBe("tok1");
    // exactly one waiting job on the shared queue (nothing double-enqueued)
    expect(await queues.queue("turns").getWaitingCount()).toBe(1);
    await job!.remove();
    await redis.del(keys.coalesce("s-coal"));
  });

  test("different sessions never coalesce", async () => {
    await ready;
    const a = await queues.enqueueTurn(turn("s-a", ["a"]), "shared");
    const b = await queues.enqueueTurn(turn("s-b", ["b"]), "shared");
    expect(b.coalesced).toBe(false);
    expect(b.jobId).not.toBe(a.jobId);
    await queues.queue("turns").remove(a.jobId);
    await queues.queue("turns").remove(b.jobId);
  });

  test("active job does not coalesce — pre-update state check", async () => {
    await ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = startWorker("turns", async () => {
      await gate;
    });
    await queues.enqueueTurn(turn("s-active", ["first"]), "shared");
    // wait until the worker has claimed it
    await until(async () => (await queues.queue("turns").getActiveCount()) === 1);

    const res = await queues.enqueueTurn(turn("s-active", ["late"]), "shared");
    expect(res.coalesced).toBe(false);
    const fresh = await queues.queue("turns").getJob(res.jobId);
    expect((fresh!.data as TurnJob).messages.map((m) => m.text)).toEqual(["late"]);

    // remove the fresh job while the worker is still blocked, then let it finish
    await fresh!.remove();
    release();
    await until(async () => (await queues.queue("turns").getActiveCount()) === 0);
  });

  test("claim race: worker claims between updateData and state re-check → remainder re-enqueued", async () => {
    await ready;
    // A queues instance whose test hook starts a worker AFTER updateData ran
    // but BEFORE the post-update state check — deterministic worst case.
    let claimed: TurnJob | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const racing = mkQueues({
      afterUpdateData: async () => {
        const w = startWorker("turns", async (job) => {
          claimed = job.data as TurnJob;
          await gate;
        });
        w.on("error", () => {});
        await until(async () => (await queues.queue("turns").getActiveCount()) === 1);
      },
    });

    const first = await racing.enqueueTurn(turn("s-race", ["m1"]), "shared");
    const second = await racing.enqueueTurn(turn("s-race", ["m2"]), "shared");

    // The append was ambiguous (job went active), so this call's messages got
    // re-enqueued as a fresh job…
    expect(second.coalesced).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    const fresh = await queues.queue("turns").getJob(second.jobId);
    expect((fresh!.data as TurnJob).messages.map((m) => m.text)).toEqual(["m2"]);
    // …and in this interleaving the worker saw the merged data too: the m2
    // duplicate is the documented at-least-once cost of the race window.
    expect(claimed!.messages.map((m) => m.text)).toEqual(["m1", "m2"]);

    // remove the fresh job while the worker is still blocked, then let it finish
    await fresh!.remove();
    release();
    await until(async () => (await queues.queue("turns").getActiveCount()) === 0);
  });

  test("stale coalesce index (job already completed) → fresh job", async () => {
    await ready;
    const first = await queues.enqueueTurn(turn("s-stale", ["done"]), "shared");
    const w = startWorker("turns", async () => {});
    await new Promise((r) => w.on("completed", r));
    await w.close();

    // index still points at the completed job — enqueue must not append there
    const second = await queues.enqueueTurn(turn("s-stale", ["next"]), "shared");
    expect(second.coalesced).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    const fresh = await queues.queue("turns").getJob(second.jobId);
    expect((fresh!.data as TurnJob).messages.map((m) => m.text)).toEqual(["next"]);
    await fresh!.remove();
  });

  test("corrupt coalesce index is tolerated (fresh add overwrites it)", async () => {
    await ready;
    await redis.set(keys.coalesce("s-corrupt"), "not json");
    const res = await queues.enqueueTurn(turn("s-corrupt", ["ok"]), "shared");
    expect(res.coalesced).toBe(false);
    expect(JSON.parse((await redis.get(keys.coalesce("s-corrupt")))!)).toEqual({
      queue: "turns",
      jobId: res.jobId,
    });
    await queues.queue("turns").remove(res.jobId);
  });

  test("default job opts carry attempts 2 + backoff", async () => {
    await ready;
    const res = await queues.enqueueTurn(turn("s-opts", ["x"]), "shared");
    const job = await queues.queue("turns").getJob(res.jobId);
    expect(job!.opts.attempts).toBe(2);
    expect(job!.opts.backoff).toEqual({ type: "exponential", delay: 1000 });
    await job!.remove();
  });
});
