/** A cron job made in a place stores that place's boundary, and the job's turn reads in that place (rc.46). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as CronJobs from "../../src/db/cron-jobs";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { placeFor } from "../../src/memory/place";
import { placeSourceId } from "../../src/memory/place-id";
import { resetBoundaryState } from "../helpers/boundary-state";

const TEAM = "T0TEAM";
let boundaryId = "";

beforeEach(async () => {
  await resetBoundaryState();
  await db.run("DELETE FROM cron_jobs");
  await db.run("DELETE FROM boundaries");
  const r = await Domain.ensureBoundary({ service: "slack", workspace: TEAM, value: "C0CHAN", kind: "channel", state: "observed" });
  boundaryId = r.boundary.id;
});
afterEach(async () => {
  await resetBoundaryState();
  await db.run("DELETE FROM cron_jobs");
});

const make = (o: Partial<Parameters<typeof CronJobs.create>[0]> = {}) =>
  CronJobs.create({ slackTeamId: TEAM, slackChannelId: "C0CHAN", slackThreadTs: "100.0", channelId: "C0CHAN", threadTs: "100.0", createdBy: "U0ALICE", cronExpr: "0 9 * * *", prompt: "p", nextRunAt: Date.now() + 1000, ...o });

describe("cron job creation stores the boundary", () => {
  test("a job made in a channel the resolver has not cached yet still gets its boundary", async () => {
    const job = await make();
    expect(await CronJobs.boundaryIdOfJob(job.id)).toBe(boundaryId);
  });
  test("a thread job and a channel-target job both do", async () => {
    expect(await CronJobs.boundaryIdOfJob((await make({ target: "channel" })).id)).toBe(boundaryId);
  });
  test("a job with no channel (made from the console) has no boundary", async () => {
    const job = await make({ slackTeamId: undefined, slackChannelId: undefined, slackThreadTs: undefined });
    expect(await CronJobs.boundaryIdOfJob(job.id)).toBeNull();
  });
  test("a channel nobody has seen has none, and the creation does not fail", async () => {
    const job = await make({ slackChannelId: "C0UNSEEN", channelId: "C0UNSEEN" });
    expect(await CronJobs.boundaryIdOfJob(job.id)).toBeNull();
  });
});

describe("the job's turn reads in the job's place", () => {
  test("placeFor with the job id (no team, no channel) answers the stored boundary's place", async () => {
    const job = await make();
    const ref = await placeFor({ agentId: "AGENT1", teamId: null, channel: null, cronJobId: job.id });
    expect(ref).toMatchObject({ kind: "place", boundaryId, source: placeSourceId("AGENT1", boundaryId) });
  });
  test("a console job with no place stays unknown", async () => {
    const job = await make({ slackTeamId: undefined, slackChannelId: undefined, slackThreadTs: undefined });
    const ref = await placeFor({ agentId: "AGENT1", teamId: null, channel: null, cronJobId: job.id });
    expect(ref.kind).toBe("none");
  });
});
