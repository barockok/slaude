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
    const res = await queues.enqueueTurn(turn("s-round", ["hello"]), { label: "default" });
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
    const first = await queues.enqueueTurn(turn("s-coal", ["one"], "tok1"), { label: "default" });
    const second = await queues.enqueueTurn(turn("s-coal", ["two", "three"], "tok2"), { label: "default" });
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
    const a = await queues.enqueueTurn(turn("s-a", ["a"]), { label: "default" });
    const b = await queues.enqueueTurn(turn("s-b", ["b"]), { label: "default" });
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
    await queues.enqueueTurn(turn("s-active", ["first"]), { label: "default" });
    // wait until the worker has claimed it
    await until(async () => (await queues.queue("turns").getActiveCount()) === 1);

    const res = await queues.enqueueTurn(turn("s-active", ["late"]), { label: "default" });
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

    const first = await racing.enqueueTurn(turn("s-race", ["m1"]), { label: "default" });
    const second = await racing.enqueueTurn(turn("s-race", ["m2"]), { label: "default" });

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
    const first = await queues.enqueueTurn(turn("s-stale", ["done"]), { label: "default" });
    const w = startWorker("turns", async () => {});
    await new Promise((r) => w.on("completed", r));
    await w.close();

    // index still points at the completed job — enqueue must not append there
    const second = await queues.enqueueTurn(turn("s-stale", ["next"]), { label: "default" });
    expect(second.coalesced).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    const fresh = await queues.queue("turns").getJob(second.jobId);
    expect((fresh!.data as TurnJob).messages.map((m) => m.text)).toEqual(["next"]);
    await fresh!.remove();
  });

  test("corrupt coalesce index is tolerated (fresh add overwrites it)", async () => {
    await ready;
    await redis.set(keys.coalesce("s-corrupt"), "not json");
    const res = await queues.enqueueTurn(turn("s-corrupt", ["ok"]), { label: "default" });
    expect(res.coalesced).toBe(false);
    expect(JSON.parse((await redis.get(keys.coalesce("s-corrupt")))!)).toEqual({
      queue: "turns",
      jobId: res.jobId,
    });
    await queues.queue("turns").remove(res.jobId);
  });

  test("default job opts carry attempts 2 + backoff", async () => {
    await ready;
    const res = await queues.enqueueTurn(turn("s-opts", ["x"]), { label: "default" });
    const job = await queues.queue("turns").getJob(res.jobId);
    expect(job!.opts.attempts).toBe(2);
    expect(job!.opts.backoff).toEqual({ type: "exponential", delay: 1000 });
    await job!.remove();
  });

  // ── Node labels spec §4.6 ─────────────────────────────────────────────────
  test("label targets: default is the bare queue, another label its own; 'shared' is still default", async () => {
    await ready;
    expect(queues.queueName({ label: "default" })).toBe("turns");
    expect(queues.queueName("shared")).toBe("turns");
    expect(queues.queueName({ label: "finance" })).toBe("turns.label.finance");
    expect(queues.queueName({ node: "n1" })).toBe("turns.n1");
    const res = await queues.enqueueTurn({ ...turn("s-lab", ["x"]), label: "finance" }, { label: "finance" });
    expect(res.queue).toBe("turns.label.finance");
    expect(await queues.queue("turns.label.finance").getWaitingCount()).toBe(1);
    expect(() => queues.queueName({ label: "Bad" })).toThrow();
    await queues.queue("turns.label.finance").remove(res.jobId);
  });

  test("a relabel moves the pending job to the new queue with the message appended, under the new token and id", async () => {
    await ready;
    const first = await queues.enqueueTurn({ ...turn("s-relabel", ["one"], "tok-eng"), label: "engineering" }, { label: "engineering" }, "relabel-1");
    expect(first.queue).toBe("turns.label.engineering");
    const second = await queues.enqueueTurn({ ...turn("s-relabel", ["two"], "tok-fin"), label: "finance" }, { label: "finance" }, "relabel-2");
    expect(second).toEqual({ jobId: "relabel-2", queue: "turns.label.finance", coalesced: true });
    // Nothing left on the old label's queue: no message is stranded there.
    expect(await queues.queue("turns.label.engineering").getJob("relabel-1")).toBeUndefined();
    const moved = await queues.queue("turns.label.finance").getJob("relabel-2");
    const data = moved!.data as TurnJob;
    expect(data.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(data.jobToken).toBe("tok-fin");
    expect(data.label).toBe("finance");
    // The follower is told where the old job went, and the index follows it.
    expect(await queues.movedTo("relabel-1")).toEqual({ queue: "turns.label.finance", jobId: "relabel-2" });
    expect(JSON.parse((await redis.get(keys.coalesce("s-relabel")))!)).toEqual({ queue: "turns.label.finance", jobId: "relabel-2" });
    // A third message on the same label now coalesces in place.
    const third = await queues.enqueueTurn({ ...turn("s-relabel", ["three"], "tok-fin2"), label: "finance" }, { label: "finance" }, "relabel-3");
    expect(third).toEqual({ jobId: "relabel-2", queue: "turns.label.finance", coalesced: true });
    await moved!.remove();
    await redis.del(keys.coalesce("s-relabel"));
  });

  test("a relabel that loses the race to a claim adds only the new message", async () => {
    await ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let claimedResolve!: () => void;
    const claimedP = new Promise<void>((r) => (claimedResolve = r));
    const w = startWorker("turns.label.engineering", async () => {
      claimedResolve();
      await gate;
    });
    await queues.enqueueTurn({ ...turn("s-relabel-race", ["one"]), label: "engineering" }, { label: "engineering" }, "rr-1");
    await claimedP;
    const res = await queues.enqueueTurn({ ...turn("s-relabel-race", ["two"]), label: "finance" }, { label: "finance" }, "rr-2");
    expect(res.coalesced).toBe(false);
    const j = await queues.queue("turns.label.finance").getJob("rr-2");
    expect((j!.data as TurnJob).messages.map((m) => m.text)).toEqual(["two"]);
    release();
    await new Promise((r) => w.on("completed", r));
    await j!.remove();
  });

  test("moveTo keeps the job id, re-points the index and leaves a marker; a claimed original stays for its worker", async () => {
    await ready;
    await queues.enqueueTurn({ ...turn("s-mv", ["x"]), label: "finance" }, { label: "default" }, "mv-1");
    const orig = await queues.queue("turns").getJob("mv-1");
    const res = await queues.moveTo(orig!, "finance");
    expect(res).toEqual({ jobId: "mv-1", queue: "turns.label.finance", coalesced: false });
    expect(await queues.queue("turns").getJob("mv-1")).toBeUndefined();
    expect(((await queues.queue("turns.label.finance").getJob("mv-1"))!.data as TurnJob).messages[0]!.text).toBe("x");
    expect(await queues.movedTo("mv-1")).toEqual({ queue: "turns.label.finance", jobId: "mv-1" });
    expect(JSON.parse((await redis.get(keys.coalesce("s-mv")))!)).toEqual({ queue: "turns.label.finance", jobId: "mv-1" });
    // Already there: a no-op.
    const again = await queues.moveTo((await queues.queue("turns.label.finance").getJob("mv-1"))!, "finance");
    expect(again.queue).toBe("turns.label.finance");
    expect(await queues.queue("turns.label.finance").getWaitingCount()).toBe(1);
    await queues.queue("turns.label.finance").remove("mv-1");
    await redis.del(keys.coalesce("s-mv"));
  });

  // Review R2-1: a worker claiming the original inside the move's window must
  // not leave a second, already-claimable copy behind.
  test("a relabel racing a claim runs every message exactly once", async () => {
    await ready;
    const ran: Array<{ queue: string; texts: string[] }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A turn takes a while: the claimed original stays locked (active).
    const record = (queue: string) => async (job: Job) => {
      ran.push({ queue, texts: (job.data as TurnJob).messages.map((m) => m.text) });
      await gate;
    };
    await queues.enqueueTurn({ ...turn("s-race-relabel", ["m1"]), label: "racea" }, { label: "racea" }, "rr-orig");
    let wA: Worker | undefined;
    const racing = mkQueues({
      beforeSwapRemove: async () => {
        // Inside the window: a worker on the old queue claims the original,
        // and an idle worker waits on the new queue.
        wA = startWorker("turns.label.racea", record("racea"));
        await until(async () => (await (await queues.queue("turns.label.racea").getJob("rr-orig"))!.getState()) !== "waiting", 5000);
        startWorker("turns.label.raceb", record("raceb"));
        await new Promise((r) => setTimeout(r, 300));
      },
    });
    const res = await racing.enqueueTurn({ ...turn("s-race-relabel", ["m2"]), label: "raceb" }, { label: "raceb" }, "rr-new");
    expect(res).toEqual({ jobId: "rr-new", queue: "turns.label.raceb", coalesced: false });
    await until(() => ran.length >= 2, 5000);
    release();
    await new Promise((r) => setTimeout(r, 500)); // room for a duplicate to show
    expect(ran.sort((a, b) => a.queue.localeCompare(b.queue))).toEqual([
      { queue: "racea", texts: ["m1"] },
      { queue: "raceb", texts: ["m2"] },
    ]);
    expect(await queues.movedTo("rr-orig")).toBeNull();
    void wA;
  });

  // Review R2-3: only a label change relocates; warmth changes append in place.
  test("a warmth change under the same label appends in place (same id, same token)", async () => {
    await ready;
    await queues.enqueueTurn({ ...turn("s-warm-flip", ["one"], "tok-1"), label: "default" }, { node: "flipnode" }, "wf-1");
    const second = await queues.enqueueTurn({ ...turn("s-warm-flip", ["two"], "tok-2"), label: "default" }, { label: "default" }, "wf-2");
    expect(second).toEqual({ jobId: "wf-1", queue: "turns.flipnode", coalesced: true });
    const j = await queues.queue("turns.flipnode").getJob("wf-1");
    expect((j!.data as TurnJob).messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect((j!.data as TurnJob).jobToken).toBe("tok-1");
    expect(await queues.movedTo("wf-1")).toBeNull();
    // An old job with no label is `default` too: still in place.
    await queues.queue("turns.flipnode").remove("wf-1");
    await queues.enqueueTurn(turn("s-warm-flip2", ["a"]), { label: "default" }, "wf-3");
    const back = await queues.enqueueTurn({ ...turn("s-warm-flip2", ["b"]), label: "default" }, { node: "flipnode" }, "wf-4");
    expect(back).toEqual({ jobId: "wf-3", queue: "turns", coalesced: true });
    await queues.queue("turns").remove("wf-3");
    await redis.del(keys.coalesce("s-warm-flip"), keys.coalesce("s-warm-flip2"));
  });

  // Review R2-2: a re-delivered claim after the copy was made adds nothing.
  test("moveTo for a claimed job is idempotent when the copy is waiting", async () => {
    await ready;
    await queues.enqueueTurn({ ...turn("s-redeliver", ["x"]), label: "redel" }, { label: "default" }, "rd-1");
    const orig = (await queues.queue("turns").getJob("rd-1"))!;
    const first = await queues.moveTo(orig, "redel", { claimed: true });
    const again = await queues.moveTo(orig, "redel", { claimed: true });
    expect(first).toEqual({ jobId: "rd-1", queue: "turns.label.redel", coalesced: false });
    expect(again).toEqual({ jobId: "rd-1", queue: "turns.label.redel", coalesced: false });
    const copies = await queues.queue("turns.label.redel").getJobs(["waiting", "active", "delayed"]);
    expect(copies.map((c) => c.id)).toEqual(["rd-1"]);
    expect((copies[0]!.data as TurnJob).messages.map((m) => m.text)).toEqual(["x"]);
    await queues.queue("turns.label.redel").remove("rd-1");
    await queues.queue("turns").remove("rd-1");
    await redis.del(keys.coalesce("s-redeliver"));
  });

  test("moveTo for a claimed job is idempotent when the copy is already running", async () => {
    await ready;
    await queues.enqueueTurn({ ...turn("s-redeliver2", ["y"]), label: "redel2" }, { label: "default" }, "rd-2");
    const orig = (await queues.queue("turns").getJob("rd-2"))!;
    await queues.moveTo(orig, "redel2", { claimed: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const w = startWorker("turns.label.redel2", async () => {
      runs++;
      await gate;
    });
    await until(async () => runs === 1, 5000);
    const again = await queues.moveTo(orig, "redel2", { claimed: true });
    expect(again.queue).toBe("turns.label.redel2");
    expect(again.jobId).toBe("rd-2");
    const counts = await queues.queue("turns.label.redel2").getJobCounts("waiting", "active", "delayed");
    expect(counts).toEqual({ waiting: 0, active: 1, delayed: 0 });
    release();
    await new Promise((r) => w.on("completed", r));
    expect(runs).toBe(1);
    await queues.queue("turns").remove("rd-2");
    await redis.del(keys.coalesce("s-redeliver2"));
  });

  test("labelQueues lists turns first and every label queue that exists, once", async () => {
    await ready;
    const a = await queues.enqueueTurn({ ...turn("s-lq-a", ["x"]), label: "ops" }, { label: "ops" });
    const b = await queues.enqueueTurn({ ...turn("s-lq-b", ["x"]), label: "ops" }, { label: "ops" });
    const lq = await queues.labelQueues();
    expect(lq[0]).toEqual({ queue: "turns", label: "default" });
    expect(lq.filter((q) => q.label === "ops")).toEqual([{ queue: "turns.label.ops", label: "ops" }]);
    // A node's own queue is not a label queue.
    expect(lq.some((q) => q.queue.startsWith("turns.nodeA"))).toBe(false);
    await queues.queue("turns.label.ops").remove(a.jobId);
    await queues.queue("turns.label.ops").remove(b.jobId);
  });

  test("peekJob reads a job on an uncached queue name and leaves the shared connection open", async () => {
    await ready;
    const fresh = mkQueues();
    const res = await queues.enqueueTurn(turn("s-peek", ["x"]), { node: "peek-node" }, "peek-job-1");
    const j = await fresh.peekJob(res.queue, "peek-job-1");
    expect((j?.data as TurnJob).sessionId).toBe("s-peek");
    expect(await fresh.peekJob("turns.nobody", "peek-job-1")).toBeUndefined();
    // The injected connection survived the temporary handle's close.
    expect(await redis.ping()).toBe("PONG");
    expect(await queues.queue(res.queue).getWaitingCount()).toBeGreaterThanOrEqual(1);
    await j!.remove();
  });

  // Review U10b-C: the queue name comes from a token-reissue caller. A peek of
  // a job that does not exist must not create the queue (a BullMQ handle
  // writes the queue's `:meta` key), or junk names become "labels in use".
  test("peekJob of a missing job creates no queue, so 100 junk names do not list as label queues", async () => {
    await ready;
    const fresh = mkQueues();
    for (let i = 0; i < 100; i++) {
      expect(await fresh.peekJob(`turns.label.junk-${i}`, "nope")).toBeUndefined();
    }
    const metas = await redis.keys(`${keys.bullPrefix}:turns.label.junk-*`);
    expect(metas).toEqual([]);
    expect((await queues.labelQueues()).some((q) => q.label.startsWith("junk-"))).toBe(false);
  });
});
