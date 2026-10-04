/**
 * D1.2: a cron job records the Slack app it was created under, so a run after
 * a restart (or on another replica) posts as that app, not as the oldest
 * registered one. Checked on both dialects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as CronJobs from "../../src/db/cron-jobs";

const base = {
  slackTeamId: "T0AAA",
  slackChannelId: "C1",
  channelId: "C1",
  createdBy: "U1",
  cronExpr: "* * * * *",
  prompt: "work",
  nextRunAt: 1,
};

describe("cron_jobs.slack_app_id", () => {
  test("sqlite: the app id round-trips; a job without one reads back null", async () => {
    const withApp = await CronJobs.create({ ...base, slackAppId: "A0TWO" });
    const without = await CronJobs.create(base);
    expect((await CronJobs.findById(withApp.id))!.slackAppId).toBe("A0TWO");
    expect((await CronJobs.findById(without.id))!.slackAppId).toBeNull();
    await db.run("DELETE FROM cron_jobs WHERE id IN (?, ?)", [withApp.id, without.id]);
  });

  let pg: DbClient;
  beforeAll(async () => {
    pg = await openDb({ dialect: "pg", driver: "pglite" });
    await runMigrations(pg, { log: () => {} });
  });
  afterAll(async () => {
    await pg?.close?.();
  });

  test("postgres: the migration adds a nullable slack_app_id column", async () => {
    const cols = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'cron_jobs' AND column_name = 'slack_app_id'`,
    );
    expect(cols).toEqual([{ column_name: "slack_app_id", is_nullable: "YES" }]);
  });
});
