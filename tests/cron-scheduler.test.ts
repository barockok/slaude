import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as CronJobs from "../src/db/cron-jobs";

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
