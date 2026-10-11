/**
 * Claiming a due cron occurrence.
 *
 * next_run_at used to advance only when the turn finished, and the re-entry
 * guard was an in-process Set. So a leadership change while a cron turn was in
 * flight left the row still due, and the new leader fired it again. The claim
 * is a compare-and-set on the value the caller observed: exactly one replica
 * can win it, whatever else is happening.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as CronJobs from "../../src/db/cron-jobs";

const NOW = 1_800_000_000_000;

async function job(nextRunAt = NOW - 1000): Promise<CronJobs.CronJob> {
  const created = await CronJobs.create({
    slackTeamId: "TTESTTEAM1",
    slackChannelId: "C1",
    channelId: "C1",
    createdBy: "UTESTUSER1",
    cronExpr: "* * * * *",
    prompt: "work",
    nextRunAt,
    target: "channel",
  });
  return created;
}

beforeEach(async () => {
  await db.run("DELETE FROM cron_jobs");
});

describe("claimDue", () => {
  test("the first claimer wins and the row moves on", async () => {
    const j = await job();
    expect(await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000)).toBe(true);
    const after = await CronJobs.findById(j.id);
    expect(Number(after!.nextRunAt)).toBe(NOW + 60_000);
  });

  // The failure this exists to stop: two gateways, one occurrence.
  test("a second claimer of the same occurrence loses", async () => {
    const j = await job();
    const results = await Promise.all([
      CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000),
      CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000),
      CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a claim against a stale observation loses", async () => {
    const j = await job();
    await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000);
    expect(await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 120_000)).toBe(false);
  });

  test("a deactivated job cannot be claimed", async () => {
    const j = await job();
    await CronJobs.deactivate(j.id);
    expect(await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000)).toBe(false);
  });

  test("a paused job cannot be claimed", async () => {
    const j = await job();
    await CronJobs.pause(j.id);
    expect(await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000)).toBe(false);
  });

  test("the claim does not touch the result of the previous run", async () => {
    const j = await job();
    await CronJobs.recordRun(j.id, "completed");
    await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000);
    expect((await CronJobs.findById(j.id))!.lastResult).toBe("completed");
  });
});

describe("releaseClaim", () => {
  // The occurrence is only really taken once the turn is enqueued. If that
  // throws, giving the slot back is better than dropping the run.
  test("gives the occurrence back when nothing was dispatched", async () => {
    const j = await job();
    await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000);

    expect(await CronJobs.releaseClaim(j.id, NOW + 60_000, j.nextRunAt)).toBe(true);

    expect(Number((await CronJobs.findById(j.id))!.nextRunAt)).toBe(j.nextRunAt);
  });

  test("does nothing when the row has moved on since", async () => {
    const j = await job();
    await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000);
    await CronJobs.claimDue(j.id, NOW + 60_000, NOW + 120_000);

    expect(await CronJobs.releaseClaim(j.id, NOW + 60_000, j.nextRunAt)).toBe(false);
    expect(Number((await CronJobs.findById(j.id))!.nextRunAt)).toBe(NOW + 120_000);
  });
});

describe("recordRun", () => {
  test("records the outcome without moving the schedule", async () => {
    const j = await job();
    await CronJobs.claimDue(j.id, j.nextRunAt, NOW + 60_000);

    await CronJobs.recordRun(j.id, "error: boom");

    const after = await CronJobs.findById(j.id);
    expect(after!.lastResult).toBe("error: boom");
    expect(Number(after!.nextRunAt)).toBe(NOW + 60_000);
    expect(after!.lastRunAt).toBeGreaterThan(0);
  });
});
