import { describe, expect, test, beforeEach, mock } from "bun:test";
import { db } from "../src/db/schema";
import * as CronJobs from "../src/db/cron-jobs";
import { parseCron, getNextRun } from "../src/gateway/slack/cron-parser";
import { CronScheduler } from "../src/gateway/slack/cron-scheduler";

describe("cron-jobs DB", () => {
  beforeEach(() => {
    db.run("DELETE FROM cron_jobs");
  });

  test("creates and finds due job", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    expect(job.id).toBeTruthy();
    const due = CronJobs.findDue(now);
    expect(due.length).toBe(1);
    expect(due[0]!.prompt).toBe("summarize");
  });

  test("does not find future job", () => {
    const now = Date.now();
    CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now + 600_000,
    });
    expect(CronJobs.findDue(now).length).toBe(0);
  });

  test("updates next run", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const next = now + 24 * 60 * 60 * 1000;
    CronJobs.updateNextRun(job.id, next, "done");
    const updated = CronJobs.findById(job.id);
    expect(updated?.nextRunAt).toBe(next);
    expect(updated?.lastResult).toBe("done");
  });

  test("deactivates job", () => {
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: Date.now(),
    });
    CronJobs.deactivate(job.id);
    expect(CronJobs.findDue(Date.now()).length).toBe(0);
  });

  test("lists active jobs", () => {
    CronJobs.create({ channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now() });
    CronJobs.create({ channelId: "C2", createdBy: "U2", cronExpr: "0 * * * *", prompt: "b", nextRunAt: Date.now() });
    expect(CronJobs.listActive().length).toBe(2);
  });
});

describe("CronScheduler", () => {
  test("starts and stops without error", () => {
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    scheduler.start(); // idempotent
    scheduler.stop();
    scheduler.stop(); // idempotent
    expect(true).toBe(true);
  });

  test("tick no-op when no due jobs", async () => {
    const now = Date.now();
    CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "future",
      nextRunAt: now + 600_000,
    });
    const sendMessage = mock(async () => {});
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  test("tick executes due job and updates next run", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const sendMessage = mock(async () => {});
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "sess-1" }), sendMessage } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const updated = CronJobs.findById(job.id);
    expect(updated!.nextRunAt).toBeGreaterThan(now);
    expect(updated!.lastResult).toBe("dispatched");
  });

  test("tick skips already-running job", async () => {
    const now = Date.now();
    CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "slow",
      nextRunAt: now - 1000,
    });
    let sendCount = 0;
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-1" }),
        sendMessage: async () => {
          sendCount++;
          await new Promise((r) => setTimeout(r, 50));
        },
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 10));
    scheduler.stop(); // clear timer but job still "running"
    await new Promise((r) => setTimeout(r, 10));
    // Start again — should not re-execute because job is in #running set
    scheduler.start();
    await new Promise((r) => setTimeout(r, 10));
    scheduler.stop();
    expect(sendCount).toBe(1);
  });

  test("execute error path updates next run with error status", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "fail",
      nextRunAt: now - 1000,
    });
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-1" }),
        sendMessage: async () => { throw new Error("boom"); },
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toMatch(/^error:/);
  });

  test("postResult posts message and updates next run", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const postMessage = mock(async () => ({}));
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {} } as any,
      client: { chat: { postMessage } } as any,
    });
    await scheduler.postResult(job.id, "done!");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect((postMessage.mock.calls as any)[0][0].channel).toBe("C123");
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toBe("completed");
  });

  test("postResult no-op when job missing", async () => {
    const postMessage = mock(async () => ({}));
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {} } as any,
      client: { chat: { postMessage } } as any,
    });
    await scheduler.postResult("nonexistent", "done!");
    expect(postMessage).toHaveBeenCalledTimes(0);
  });

  test("postResult swallows postMessage errors", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {} } as any,
      client: { chat: { postMessage: async () => { throw new Error("network"); } } } as any,
    });
    await scheduler.postResult(job.id, "done!");
    // no throw = pass
    expect(true).toBe(true);
  });
});

describe("cron-parser", () => {
  test("parses basic cron", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(c.minute).toEqual([0]);
    expect(c.hour).toEqual([9]);
    expect(c.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  test("parses wildcard", () => {
    const c = parseCron("0 * * * *");
    expect(c.minute).toEqual([0]);
    expect(c.hour.length).toBe(24);
  });

  test("parses step", () => {
    const c = parseCron("*/15 * * * *");
    expect(c.minute).toEqual([0, 15, 30, 45]);
  });

  test("computes next run from daily cron", () => {
    const base = new Date("2026-05-24T08:00:00Z").getTime();
    const next = getNextRun("0 9 * * *", base);
    const nextDate = new Date(next);
    expect(nextDate.getUTCHours()).toBe(9);
    expect(nextDate.getUTCDate()).toBe(24);
  });

  test("computes next run for weekly cron", () => {
    // 2026-05-24 is Sunday (0). Next Monday (1) at 9am
    const base = new Date("2026-05-24T08:00:00Z").getTime();
    const next = getNextRun("0 9 * * 1", base);
    const nextDate = new Date(next);
    expect(nextDate.getUTCDay()).toBe(1); // Monday
    expect(nextDate.getUTCHours()).toBe(9);
  });

  test("throws when cron has no valid next run", () => {
    // Feb 31st never exists — should exhaust search
    expect(() => getNextRun("0 0 31 2 *", Date.now())).toThrow(/could not find next run/);
  });
});
