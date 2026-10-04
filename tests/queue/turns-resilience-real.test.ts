/**
 * Move-helper hardening (U10a re-check F1, F3, F4) and the LABEL_MISMATCH
 * re-dispatch guard, against real Redis (gated):
 *
 *   F1  the original is taken off its queue in ONE atomic step that refuses a
 *       job a worker holds or has finished — never check-then-remove;
 *   F3  a message a pending job already holds is not appended again;
 *   F4  a crash after the original was taken never loses its messages;
 *   re-dispatch of a failed job happens once across replicas.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sweepTag, testPrefix, until } from "./real";
import type { TurnJob, TurnQueues, TurnQueuesOpts } from "../../src/queue/turns";
import type { Keys } from "../../src/queue/keys";

const prefix = testPrefix("turnsres");

let seq = 0;
function turn(sessionId: string, texts: string[], label?: string): TurnJob {
  return {
    sessionId,
    tenantId: "t_1",
    personaId: "p_1",
    ...(label ? { label } : {}),
    messages: texts.map((text) => ({ ts: `1700000000.${String(++seq).padStart(6, "0")}`, user: "U1", text })),
    jobToken: "tok",
    enqueuedAt: Date.now(),
  };
}

describe.skipIf(!realEnabled)("queue/turns hardening against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let queues: TurnQueues;
  let mkQueues: (opts?: Partial<TurnQueuesOpts>) => TurnQueues;
  const extras: TurnQueues[] = [];
  const workers: Worker[] = [];
  const conns: Redis[] = [];

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues: TQ } = await import("../../src/queue/turns");
    redis = realRedis();
    conns.push(redis);
    await sweepTag(redis, "turnsres");
    keys = makeKeys(prefix);
    mkQueues = (opts) => {
      const q = new TQ({ connection: redis, keys, ...opts });
      extras.push(q);
      return q;
    };
    queues = mkQueues();
  })();

  const startWorker = (qname: string, proc: ((job: Job) => Promise<unknown>) | null, o: Record<string, unknown> = {}): Worker => {
    const conn = realRedis();
    conns.push(conn);
    const w = new Worker(qname, proc, { connection: conn, prefix: keys.bullPrefix, ...o });
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

  test("takeUnclaimed: takes waiting and delayed jobs, refuses held, finished and (unless asked) active ones", async () => {
    await ready;
    const q = queues.queue("turns.label.take");
    await q.add("turn", turn("s-take-w", ["w"]), { jobId: "tk-wait" });
    await q.add("turn", turn("s-take-d", ["d"]), { jobId: "tk-delay", delay: 60_000 });
    expect(await queues.takeUnclaimed((await q.getJob("tk-wait"))!)).toBe("wait");
    expect(await queues.takeUnclaimed((await q.getJob("tk-delay"))!)).toBe("delayed");
    expect(await q.getJob("tk-wait")).toBeUndefined();
    // A job whose turn already ran is taken but reported `done`: copy nothing.
    await q.add("turn", turn("s-take-t", ["t"]), { jobId: "tk-ran" });
    await redis.set(keys.turnDone("tk-ran"), "done", "EX", 60);
    expect(await queues.takeUnclaimed((await q.getJob("tk-ran"))!)).toBe("done");
    expect(await q.getJob("tk-ran")).toBeUndefined();
    expect(await queues.takeUnclaimed({ id: "tk-nope", queueName: "turns.label.take" })).toBe("missing");

    // A claimed job: locked while its worker holds it.
    await q.add("turn", turn("s-take-a", ["a"]), { jobId: "tk-active" });
    const manual = startWorker("turns.label.take", null, { autorun: false, lockDuration: 400 });
    const claimed = await manual.getNextJob("tok-1");
    expect(claimed!.id).toBe("tk-active");
    expect(await queues.takeUnclaimed(claimed!)).toBe("locked");
    expect(await queues.takeUnclaimed(claimed!, { rescueActive: true })).toBe("locked");
    // The lock lapses (nothing renews a manual claim): active, unlocked.
    await until(async () => (await redis.exists(`${keys.bullPrefix}:turns.label.take:tk-active:lock`)) === 0, 5000);
    expect(await queues.takeUnclaimed(claimed!)).toBe("claimed");
    expect(await queues.takeUnclaimed(claimed!, { rescueActive: true })).toBe("active");
    expect(await q.getJob("tk-active")).toBeUndefined();
    expect(await q.getActiveCount()).toBe(0);

    // A finished job is never taken.
    await q.add("turn", turn("s-take-c", ["c"]), { jobId: "tk-done" });
    const w = startWorker("turns.label.take", async () => "ok");
    await new Promise((r) => w.on("completed", r));
    expect(await queues.takeUnclaimed((await q.getJob("tk-done"))!)).toBe("claimed");
    expect(await queues.takeUnclaimed((await q.getJob("tk-done"))!, { rescueActive: true })).toBe("claimed");
  });

  // F1: what this proves is that a move REFUSES an original a worker has
  // already finished (claimed and completed before the take): the held copy
  // is dropped, so each message runs once. That no claim can slip in between
  // the check and the removal is not something a test can race: the take is
  // one Lua script, atomic by construction.
  test("a move refuses an original a worker already finished and drops its copy", async () => {
    await ready;
    const ran: string[] = [];
    const record = async (job: Job) => {
      ran.push(...(job.data as TurnJob).messages.map((m) => m.text));
    };
    await queues.enqueueTurn(turn("s-f1", ["m1"], "fonea"), { label: "fonea" }, "f1-orig");
    const racing = mkQueues({
      beforeSwapRemove: async () => {
        // Instant finish (like an abort-flag skip): claimed and completed
        // before the move takes the original.
        const w = startWorker("turns.label.fonea", record);
        await new Promise((r) => w.on("completed", r));
        startWorker("turns.label.foneb", record);
      },
    });
    const res = await racing.enqueueTurn(turn("s-f1", ["m2"], "foneb"), { label: "foneb" }, "f1-new");
    expect(res).toEqual({ jobId: "f1-new", queue: "turns.label.foneb", coalesced: false });
    await until(() => ran.length >= 2, 5000);
    await new Promise((r) => setTimeout(r, 300)); // room for a duplicate to show
    expect(ran.sort()).toEqual(["m1", "m2"]);
    expect(await queues.movedTo("f1-orig")).toBeNull();
  });

  // F3: a re-delivered message appends once.
  test("a message the pending job already holds is not appended again", async () => {
    await ready;
    const first = turn("s-f3", ["hello"]);
    const a = await queues.enqueueTurn(first, { label: "default" }, "f3-1");
    const again = await queues.enqueueTurn({ ...first, jobToken: "tok-2" }, { label: "default" }, "f3-2");
    expect(again).toEqual({ jobId: a.jobId, queue: "turns", coalesced: true });
    const more = turn("s-f3", ["world"]);
    await queues.enqueueTurn({ ...more, messages: [...first.messages, ...more.messages] }, { label: "default" });
    const j = await queues.queue("turns").getJob("f3-1");
    expect((j!.data as TurnJob).messages.map((m) => m.text)).toEqual(["hello", "world"]);
    await j!.remove();
    await redis.del(keys.coalesce("s-f3"));
  });

  test("a claimed move re-delivered after a crash between append and marker appends once", async () => {
    await ready;
    // The session's pending job on the target label, and a mismatched claim
    // of an OLDER message (built first: merges order by Slack ts).
    const older = turn("s-f3b", ["claimed"], "fthree");
    await queues.enqueueTurn(turn("s-f3b", ["pending"], "fthree"), { label: "fthree" }, "f3b-pending");
    await redis.del(keys.coalesce("s-f3b"));
    await queues.enqueueTurn(older, { label: "default" }, "f3b-claimed");
    await redis.set(keys.coalesce("s-f3b"), JSON.stringify({ queue: "turns.label.fthree", jobId: "f3b-pending" }));
    const claimed = (await queues.queue("turns").getJob("f3b-claimed"))!;
    expect(await queues.moveTo(claimed, "fthree", { claimed: true })).toEqual({
      jobId: "f3b-pending", queue: "turns.label.fthree", coalesced: true,
    });
    // Crash before the marker landed: the re-delivery appends again.
    await redis.del(keys.jobMoved("f3b-claimed"));
    await queues.moveTo(claimed, "fthree", { claimed: true });
    const j = await queues.queue("turns.label.fthree").getJob("f3b-pending");
    // The claimed job's messages are the older ones: they go first (U10b-A).
    expect((j!.data as TurnJob).messages.map((m) => m.text)).toEqual(["claimed", "pending"]);
    await j!.remove();
    await queues.queue("turns").remove("f3b-claimed");
    await redis.del(keys.coalesce("s-f3b"));
  });

  // F4: the merge into another pending job used to remove the original first
  // and append after; a crash in between lost the messages.
  test("a crash after the original was taken leaves its messages in a held copy", async () => {
    await ready;
    await queues.enqueueTurn(turn("s-f4", ["indexed"], "ffour"), { label: "ffour" }, "f4-indexed");
    await redis.del(keys.coalesce("s-f4"));
    await queues.enqueueTurn(turn("s-f4", ["stranded"], "ffour"), { node: "f4node" }, "f4-stranded");
    await redis.set(keys.coalesce("s-f4"), JSON.stringify({ queue: "turns.label.ffour", jobId: "f4-indexed" }));
    const crashing = mkQueues({
      afterTakeOriginal: async () => {
        throw new Error("simulated crash");
      },
    });
    const stranded = (await queues.queue("turns.f4node").getJob("f4-stranded"))!;
    await expect(crashing.moveTo(stranded, "ffour")).rejects.toThrow("simulated crash");
    // The original is gone from the node queue...
    expect(await queues.queue("turns.f4node").getJob("f4-stranded")).toBeUndefined();
    // ...and its messages wait in a held copy on the target queue, which the
    // job-moved marker points at, so a follower keeps following the turn.
    const moved = await queues.movedTo("f4-stranded");
    expect(moved?.queue).toBe("turns.label.ffour");
    const held = await queues.queue("turns.label.ffour").getJob(moved!.jobId);
    expect(await held!.getState()).toBe("delayed");
    expect((held!.data as TurnJob).messages.map((m) => m.text)).toEqual(["stranded"]);
    // Without the crash the same move merges into the indexed job and drops
    // the held copy.
    await held!.remove();
    await redis.del(keys.jobMoved("f4-stranded"), keys.coalesce("s-f4"));
    // A stranded job older than the indexed one (merges order by Slack ts).
    const stranded2 = { ...turn("s-f4", ["stranded2"], "ffour"), messages: [{ ts: "1699999999.000001", user: "U1", text: "stranded2" }] };
    await queues.enqueueTurn(stranded2, { node: "f4node" }, "f4-stranded2");
    await redis.set(keys.coalesce("s-f4"), JSON.stringify({ queue: "turns.label.ffour", jobId: "f4-indexed" }));
    const res = await queues.moveTo((await queues.queue("turns.f4node").getJob("f4-stranded2"))!, "ffour");
    expect(res).toEqual({ jobId: "f4-indexed", queue: "turns.label.ffour", coalesced: true });
    const ix = await queues.queue("turns.label.ffour").getJob("f4-indexed");
    // The moved job's messages go before the indexed job's (U10b-A).
    expect((ix!.data as TurnJob).messages.map((m) => m.text)).toEqual(["stranded2", "indexed"]);
    expect(await queues.queue("turns.label.ffour").getDelayedCount()).toBe(0);
    expect(await queues.movedTo("f4-stranded2")).toEqual({ queue: "turns.label.ffour", jobId: "f4-indexed" });
    await ix!.remove();
    await redis.del(keys.coalesce("s-f4"));
  });

  test("a re-dispatch of a failed job happens once across replicas", async () => {
    await ready;
    const other = mkQueues();
    const data = { ...turn("s-redisp", ["again"], "rdlabel"), relabelAttempts: 1 };
    const [a, b] = await Promise.all([
      queues.redispatch("rd-failed", data, "rdlabel", "rd-new-a"),
      other.redispatch("rd-failed", { ...data }, "rdlabel", "rd-new-b"),
    ]);
    const won = [a, b].filter((r) => r !== null);
    expect(won).toHaveLength(1);
    expect(won[0]!.queue).toBe("turns.label.rdlabel");
    expect(await queues.movedTo("rd-failed")).toEqual({ queue: won[0]!.queue, jobId: won[0]!.jobId });
    const jobs = await queues.queue("turns.label.rdlabel").getJobs(["waiting"]);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.data as TurnJob).relabelAttempts).toBe(1);
    await jobs[0]!.remove();
    await redis.del(keys.coalesce("s-redisp"));
  });

  // Review U10b-B: a re-dispatched turn holds the OLDER messages. Coalesced
  // into the session's pending job they go first, and the merged job keeps the
  // re-dispatch count so the one-re-dispatch bound is not reset.
  test("a re-dispatch coalesced into a pending job runs first and keeps relabelAttempts", async () => {
    await ready;
    // The failed turn's message was sent first (merges order by Slack ts).
    const failed = { ...turn("s-rdco", ["m1"], "rdco"), relabelAttempts: 1 };
    await queues.enqueueTurn(turn("s-rdco", ["m2"], "rdco"), { label: "rdco" }, "rdco-pending");
    const res = await queues.redispatch("rdco-failed", failed, "rdco", "rdco-new");
    expect(res).toEqual({ jobId: "rdco-pending", queue: "turns.label.rdco", coalesced: true });
    const j = (await queues.queue("turns.label.rdco").getJob("rdco-pending"))!;
    expect((j.data as TurnJob).messages.map((m) => m.text)).toEqual(["m1", "m2"]);
    expect((j.data as TurnJob).relabelAttempts).toBe(1);
    await j.remove();
    await redis.del(keys.coalesce("s-rdco"));

    // The same when the pending job sits on another label and is relocated.
    const failed2 = { ...turn("s-rdrl", ["n1"], "rdnew"), relabelAttempts: 1 };
    await queues.enqueueTurn(turn("s-rdrl", ["n2"], "rdold"), { label: "rdold" }, "rdrl-pending");
    const res2 = await queues.redispatch("rdrl-failed", failed2, "rdnew", "rdrl-new");
    expect(res2).toEqual({ jobId: "rdrl-new", queue: "turns.label.rdnew", coalesced: true });
    const k = (await queues.queue("turns.label.rdnew").getJob("rdrl-new"))!;
    expect((k.data as TurnJob).messages.map((m) => m.text)).toEqual(["n1", "n2"]);
    expect((k.data as TurnJob).relabelAttempts).toBe(1);
    await k.remove();
    await redis.del(keys.coalesce("s-rdrl"));
  });

  test("mergesFirst orders by the earliest Slack ts; the caller's hint decides only when the ts cannot", async () => {
    await ready;
    const { mergesFirst } = await import("../../src/queue/turns");
    const at = (...ts: string[]): TurnJob => ({ ...turn("s-mf", ts.map(() => "x")), messages: ts.map((t) => ({ ts: t, user: "U1", text: t })) });
    expect(mergesFirst(at("1700000000.000200"), at("1700000000.000100"))).toBe(true);
    expect(mergesFirst(at("1700000000.000100"), at("1700000000.000200"), true)).toBe(false);
    // Compared exactly: these two are equal as doubles.
    expect(mergesFirst(at("1700000000.0000002"), at("1700000000.0000001"))).toBe(true);
    // Seconds before fraction; a short fraction is padded, not read as an integer.
    expect(mergesFirst(at("1700000001.000001"), at("1700000000.9"))).toBe(true);
    expect(mergesFirst(at("1700000000.000001"), at("1700000000.1"))).toBe(false);
    // The earliest message of each job counts.
    expect(mergesFirst(at("1700000000.000300"), at("1700000000.000400", "1700000000.000200"))).toBe(true);
    // A tie or a non-Slack ts: the hint.
    expect(mergesFirst(at("1700000000.000100"), at("1700000000.000100"), true)).toBe(true);
    expect(mergesFirst(at("1700000000.000100"), at("sim-1"), true)).toBe(true);
    expect(mergesFirst(at("1700000000.000100"), at("sim-1"))).toBe(false);
  });
});
