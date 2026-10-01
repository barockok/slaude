/**
 * Cron under a leadership change.
 *
 * The schedule used to advance only when the turn finished, guarded by an
 * in-process Set. A cron leader dying mid-turn therefore left the occurrence
 * due, and the next leader fired it again. Now the occurrence is claimed —
 * compare-and-set on next_run_at — before anything is dispatched, so exactly
 * one replica can take it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db/schema";
import * as CronJobs from "../src/db/cron-jobs";
import { CronScheduler } from "../src/gateway/slack/cron-scheduler";

const due = () =>
  CronJobs.create({
    slackTeamId: "TTESTTEAM1",
    slackChannelId: "C1",
    channelId: "C1",
    createdBy: "UTESTUSER1",
    cronExpr: "* * * * *",
    prompt: "work",
    nextRunAt: Date.now() - 1000,
    target: "channel",
  });

/** One replica's scheduler. `send` stands in for the queue dispatch. */
function replica(opts: { send?: (a: any) => Promise<void>; isLive?: boolean } = {}) {
  const sent: any[] = [];
  const handlers = new Set<(e: any) => void>();
  const agent = {
    ensureSession: async () => ({ id: "S-cron" }),
    sendMessage: async () => {},
    setCronOAuthUser: () => {},
    isLive: () => opts.isLive ?? false,
    on: (_n: string, fn: any) => handlers.add(fn),
    off: (_n: string, fn: any) => handlers.delete(fn),
  } as any;
  const scheduler = new CronScheduler({
    agent,
    client: { chat: { postMessage: async () => ({}) } } as any,
    send: async (a: any) => {
      sent.push(a);
      if (opts.send) await opts.send(a);
    },
    isLive: async () => opts.isLive ?? false,
  } as any);
  const finish = (type: "done" | "error") => {
    for (const fn of [...handlers]) fn({ type, sessionId: "S-cron", error: "boom" });
  };
  return { scheduler, sent, finish };
}

/** start() fires a tick immediately; stop() leaves the interval off. */
async function tickOnce(r: { scheduler: CronScheduler }) {
  r.scheduler.start();
  r.scheduler.stop();
  await new Promise((res) => setTimeout(res, 60));
}

beforeEach(async () => { await db.run("DELETE FROM cron_jobs"); });
afterEach(async () => { await db.run("DELETE FROM cron_jobs"); });

describe("cron across replicas", () => {
  // The defect: two gateways, one due occurrence, two runs.
  test("two replicas ticking the same occurrence dispatch it once", async () => {
    await due();
    const a = replica();
    const b = replica();

    await Promise.all([tickOnce(a), tickOnce(b)]);

    expect(a.sent.length + b.sent.length).toBe(1);
  });

  test("the schedule moves before the turn is dispatched, not after it finishes", async () => {
    const job = await due();
    const a = replica();

    await tickOnce(a);

    expect(a.sent).toHaveLength(1);
    // Still in flight: no done/error yet, and the row has already moved on.
    const row = await CronJobs.findById(job.id);
    expect(Number(row!.nextRunAt)).toBeGreaterThan(job.nextRunAt);
  });

  // The whole point: a leader that dies mid-turn must not hand the same
  // occurrence to its successor.
  test("a successor does not re-fire an occurrence whose turn is still in flight", async () => {
    await due();
    const dying = replica();
    await tickOnce(dying);
    expect(dying.sent).toHaveLength(1);

    // The leader dies without ever emitting done — a new one takes over.
    const successor = replica();
    await tickOnce(successor);

    expect(successor.sent).toHaveLength(0);
  });

  test("the result of the run is recorded when it completes", async () => {
    const job = await due();
    const a = replica();
    await tickOnce(a);
    const scheduled = Number((await CronJobs.findById(job.id))!.nextRunAt);

    a.finish("done");
    await new Promise((res) => setTimeout(res, 30));

    const row = await CronJobs.findById(job.id);
    expect(row!.lastResult).toBe("completed");
    // Completion records the outcome; it does not move the schedule again.
    expect(Number(row!.nextRunAt)).toBe(scheduled);
  });

  test("a failed turn is recorded without re-arming the same occurrence", async () => {
    const job = await due();
    const a = replica();
    await tickOnce(a);
    const scheduled = Number((await CronJobs.findById(job.id))!.nextRunAt);

    a.finish("error");
    await new Promise((res) => setTimeout(res, 30));

    const row = await CronJobs.findById(job.id);
    expect(String(row!.lastResult)).toContain("error");
    expect(Number(row!.nextRunAt)).toBe(scheduled);
  });

  // Nothing was dispatched, so the occurrence is given back rather than lost.
  test("an occurrence whose dispatch throws is released for the next tick", async () => {
    const job = await due();
    const failing = replica({ send: async () => { throw new Error("queue unreachable"); } });

    await tickOnce(failing);

    const row = await CronJobs.findById(job.id);
    expect(Number(row!.nextRunAt)).toBe(job.nextRunAt);
    expect(String(row!.lastResult)).toContain("queue unreachable");

    // And the next leader picks it up.
    const next = replica();
    await tickOnce(next);
    expect(next.sent).toHaveLength(1);
  });

  test("a passive job skipped because the session is live still moves on", async () => {
    const job = await due();
    await CronJobs.update(job.id, { whenActive: "skip" });
    const a = replica({ isLive: true });

    await tickOnce(a);

    expect(a.sent).toHaveLength(0);
    const row = await CronJobs.findById(job.id);
    expect(Number(row!.nextRunAt)).toBeGreaterThan(job.nextRunAt);
    expect(String(row!.lastResult)).toContain("skipped");
  });
});
