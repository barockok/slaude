/** read_channel and list_cron_jobs under memory places (rc.47): this turn's channel and boundary only; unchanged otherwise. */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as CronJobs from "../../src/db/cron-jobs";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { adminHandlers, type SlackContext } from "../../src/gateway/slack/mcp-tools";
import { readChannelTool, type WakeToolContext } from "../../src/proactive/wake-tools";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { setSoulData, __resetSoulDataMemo } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { resetBoundaryState } from "../helpers/boundary-state";

const TEAM = "T0TEAM";
const SOUL = "## Proactive\n- Enabled: yes\n\n## Channel C0ONCHANNE\n### Proactive\n- Enabled: yes\n\n## Channel C0OTHERCHA\n### Proactive\n- Enabled: yes\n";
let boundaryA = "";
let boundaryB = "";

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= "AGENT1";
});
beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  setSoulData(SoulDataSchema.parse({ manager: { userId: "U0MGR" } }));
  await resetBoundaryState();
  await db.run("DELETE FROM cron_jobs");
  await db.run("DELETE FROM boundaries");
  boundaryA = (await Domain.ensureBoundary({ service: "slack", workspace: TEAM, value: "C0ONCHANNE", kind: "channel", state: "observed" })).boundary.id;
  boundaryB = (await Domain.ensureBoundary({ service: "slack", workspace: TEAM, value: "C0OTHERCHA", kind: "channel", state: "observed" })).boundary.id;
});
afterEach(async () => {
  delete process.env.SLAUDE_MEMORY_BOUNDARIES;
  __setProactiveSoulSource(null);
  __resetSoulDataMemo();
  await resetBoundaryState();
  await db.run("DELETE FROM cron_jobs");
});

const history = { messages: [{ ts: "1.0", user: "U1", text: "hello" }], has_more: false };
const readCtx = (channel: string): WakeToolContext => ({ client: { conversations: { history: async () => history, replies: async () => history } } as never, channel, teamId: TEAM });
const job = (channel: string, prompt: string) =>
  CronJobs.create({ slackTeamId: TEAM, slackChannelId: channel, slackThreadTs: "100.0", channelId: channel, threadTs: "100.0", createdBy: "U0MGR", cronExpr: "0 9 * * *", prompt, nextRunAt: Date.now() + 1000 });

describe("read_channel", () => {
  test("under on it answers only for the channel of the current turn", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    expect((await readChannelTool(readCtx("C0ONCHANNE"), { channel: "C0ONCHANNE" })).isError).toBeUndefined();
    const other = await readChannelTool(readCtx("C0ONCHANNE"), { channel: "C0OTHERCHA" });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toContain("channel this turn is in");
  });
  test("under on a wake's own channel session is the current channel", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    const c = { ...readCtx("U0MANAGER"), wake: { runId: "r", deps: {} as never, channelSession: "C0ONCHANNE" } };
    expect((await readChannelTool(c, { channel: "C0ONCHANNE" })).isError).toBeUndefined();
    expect((await readChannelTool(c, { channel: "C0OTHERCHA" })).isError).toBe(true);
  });
  test("a persona outside the canary list is unchanged", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = "someone-else";
    try {
      expect((await readChannelTool(readCtx("C0ONCHANNE"), { channel: "C0OTHERCHA" })).isError).toBeUndefined();
    } finally {
      delete process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS;
    }
  });
  for (const mode of ["off", "shadow", undefined]) {
    test(`mode ${mode ?? "unset"}: any channel the agent works in, as before`, async () => {
      if (mode) process.env.SLAUDE_MEMORY_BOUNDARIES = mode;
      expect((await readChannelTool(readCtx("C0ONCHANNE"), { channel: "C0OTHERCHA" })).isError).toBeUndefined();
      expect((await readChannelTool(readCtx("C0ONCHANNE"), { channel: "C0NOTWORKS" })).isError).toBe(true);
    });
  }
});

describe("list_cron_jobs", () => {
  const ctx = (channel: string) => ({ channel, userId: "U0MGR", teamId: TEAM, threadTs: "100.0" }) as SlackContext;
  test("under on it lists only the jobs of the current boundary", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    await job("C0ONCHANNE", "alpha job");
    await job("C0OTHERCHA", "beta job");
    const text = (await adminHandlers.listCronJobs(ctx("C0ONCHANNE"))).content[0]!.text;
    expect(text).toContain("alpha job");
    expect(text).not.toContain("beta job");
    const other = (await adminHandlers.listCronJobs(ctx("C0OTHERCHA"))).content[0]!.text;
    expect(other).toContain("beta job");
    expect(other).not.toContain("alpha job");
    expect(boundaryA).not.toBe(boundaryB);
  });
  test("a job with no boundary (made from the console) is not listed in any place", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    await CronJobs.create({ createdBy: "console", cronExpr: "0 9 * * *", prompt: "console job", channelId: "C0CONSOLE", nextRunAt: Date.now() + 1000 });
    expect((await adminHandlers.listCronJobs(ctx("C0ONCHANNE"))).content[0]!.text).toBe("No active cron jobs here.");
  });
  test("a turn whose place is unknown sees no jobs", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    await job("C0ONCHANNE", "alpha job");
    expect((await adminHandlers.listCronJobs(ctx("C0UNSEEN"))).content[0]!.text).toBe("No active cron jobs here.");
  });
  for (const mode of ["off", "shadow"]) {
    test(`mode ${mode}: every active job, as before`, async () => {
      process.env.SLAUDE_MEMORY_BOUNDARIES = mode;
      await job("C0ONCHANNE", "alpha job");
      await job("C0OTHERCHA", "beta job");
      const text = (await adminHandlers.listCronJobs(ctx("C0ONCHANNE"))).content[0]!.text;
      expect(text).toContain("*Active cron jobs*");
      expect(text).toContain("alpha job");
      expect(text).toContain("beta job");
    });
  }
});
