import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  slackHandlers,
  adminHandlers,
  parseDuration,
  type SlackContext,
} from "../src/gateway/slack/mcp-tools";
import * as CronJobs from "../src/db/cron-jobs";
import * as Ignores from "../src/db/ignores";
import { db } from "../src/db/schema";
import { setSoulData, __resetSoulDataMemo } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";

const MANAGER = "U0MGR0001";
const BACKUP = "U0BAK0001";
const APPROVER = "U0APR0001";
const RANDO = "U0RANDO01";

function makeCtx(over: Partial<SlackContext> = {}): SlackContext {
  return {
    client: {} as any,
    channel: "C0COV001",
    threadTs: "111.222",
    inboundTs: "333.444",
    userId: MANAGER,
    teamId: "T0COV001",
    ...over,
  };
}

function throwing(error: string) {
  return async () => {
    const e: any = new Error("boom");
    e.data = { error };
    throw e;
  };
}

beforeAll(() => {
  setSoulData(
    SoulDataSchema.parse({
      manager: { userId: MANAGER },
      backupManager: { userId: BACKUP },
      approvers: [{ userId: APPROVER, scope: "all", catchall: true }],
    }),
  );
});

afterAll(() => {
  __resetSoulDataMemo();
});

beforeEach(() => {
  db.run("DELETE FROM cron_jobs");
  db.run("DELETE FROM ignores");
});

describe("slackHandlers error catches", () => {
  test("get_user_profile surfaces slack error", async () => {
    const ctx = makeCtx({
      client: { users: { info: throwing("user_not_found") } } as any,
    });
    const res = await slackHandlers.get_user_profile(ctx, { user_id: "U404" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("users.info failed");
    expect(res.content[0]!.text).toContain("user_not_found");
  });

  test("get_channel_info surfaces slack error", async () => {
    const ctx = makeCtx({
      client: { conversations: { info: throwing("channel_not_found") } } as any,
    });
    const res = await slackHandlers.get_channel_info(ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("conversations.info failed");
    expect(res.content[0]!.text).toContain("channel_not_found");
  });

  test("get_thread_history surfaces slack error", async () => {
    const ctx = makeCtx({
      client: { conversations: { replies: throwing("thread_not_found") } } as any,
    });
    const res = await slackHandlers.get_thread_history(ctx, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("conversations.replies failed");
    expect(res.content[0]!.text).toContain("thread_not_found");
  });

  test("get_thread_history error without data falls back to message", async () => {
    const ctx = makeCtx({
      client: {
        conversations: {
          replies: async () => {
            throw new Error("socket hang up");
          },
        },
      } as any,
    });
    const res = await slackHandlers.get_thread_history(ctx, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("socket hang up");
  });

  test("list_users_in_channel surfaces slack error", async () => {
    const ctx = makeCtx({
      client: { conversations: { members: throwing("missing_scope") } } as any,
    });
    const res = await slackHandlers.list_users_in_channel(ctx, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("conversations.members failed");
    expect(res.content[0]!.text).toContain("missing_scope");
  });
});

describe("slackHandlers branch coverage", () => {
  test("get_thread_history includes replies by default", async () => {
    const ctx = makeCtx({
      client: {
        conversations: {
          replies: async () => ({
            messages: [
              {
                ts: "1.0",
                user: "U1",
                text: "root",
                reply_count: 1,
                replies: [{ ts: "2.0", user: "U2" }],
              },
            ],
            has_more: true,
          }),
        },
      } as any,
    });
    const res = await slackHandlers.get_thread_history(ctx, {});
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.messages[0].replies).toEqual([{ ts: "2.0", user: "U2" }]);
    expect(data.has_more).toBe(true);
  });

  test("get_thread_history omits replies when include_replies=false", async () => {
    const ctx = makeCtx({
      client: {
        conversations: {
          replies: async () => ({
            messages: [
              { ts: "1.0", user: "U1", text: "root", replies: [{ ts: "2.0", user: "U2" }] },
            ],
          }),
        },
      } as any,
    });
    const res = await slackHandlers.get_thread_history(ctx, { include_replies: false });
    const data = JSON.parse(res.content[0]!.text);
    expect(data.messages[0].replies).toBeUndefined();
  });

  test("list_users_in_channel reports has_more from next_cursor", async () => {
    const ctx = makeCtx({
      client: {
        conversations: {
          members: async () => ({
            members: ["U1"],
            response_metadata: { next_cursor: "dXNlcjpVMDYx" },
          }),
        },
      } as any,
    });
    const res = await slackHandlers.list_users_in_channel(ctx, { limit: 1 });
    const data = JSON.parse(res.content[0]!.text);
    expect(data.has_more).toBe(true);
  });
});

describe("parseDuration", () => {
  test("permanent", () => {
    expect(parseDuration("permanent")).toEqual({ ok: true, permanent: true, minutes: 0 });
  });
  test("minutes", () => {
    expect(parseDuration("5m")).toEqual({ ok: true, permanent: false, minutes: 5 });
  });
  test("hours", () => {
    expect(parseDuration("2h")).toEqual({ ok: true, permanent: false, minutes: 120 });
  });
  test("rejects over 24h", () => {
    const r = parseDuration("25h");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("24h");
  });
  test("rejects junk", () => {
    expect(parseDuration("soon").ok).toBe(false);
    expect(parseDuration("1.5h").ok).toBe(false);
    expect(parseDuration("10s").ok).toBe(false);
  });
});

describe("adminHandlers authorization (isManagerOrApprover)", () => {
  test("missing userId denied", async () => {
    const res = await adminHandlers.addCronJob(makeCtx({ userId: undefined }), {
      cronExpr: "0 9 * * *",
      prompt: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Only manager or approver");
  });

  test("random user denied", async () => {
    const res = await adminHandlers.addCronJob(makeCtx({ userId: RANDO }), {
      cronExpr: "0 9 * * *",
      prompt: "x",
    });
    expect(res.isError).toBe(true);
  });

  test("backup manager allowed", async () => {
    const res = await adminHandlers.addCronJob(makeCtx({ userId: BACKUP }), {
      cronExpr: "0 9 * * *",
      prompt: "backup job",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Cron job created");
  });

  test("approver allowed", async () => {
    const res = await adminHandlers.addCronJob(makeCtx({ userId: APPROVER }), {
      cronExpr: "0 9 * * *",
      prompt: "approver job",
    });
    expect(res.isError).toBeUndefined();
  });
});

describe("adminHandlers cron jobs", () => {
  test("listCronJobs empty", async () => {
    const res = await adminHandlers.listCronJobs();
    expect(res.content[0]!.text).toBe("No active cron jobs.");
  });

  test("listCronJobs renders passive tag for when_active=skip", async () => {
    CronJobs.create({
      channelId: "C1",
      createdBy: MANAGER,
      cronExpr: "0 9 * * *",
      prompt: "quiet digest",
      nextRunAt: Date.now(),
      whenActive: "skip",
    });
    const res = await adminHandlers.listCronJobs();
    expect(res.content[0]!.text).toContain("*Active cron jobs*");
    expect(res.content[0]!.text).toContain(", passive");
    expect(res.content[0]!.text).toContain("quiet digest");
  });

  test("addCronJob rejects invalid cron expression", async () => {
    const res = await adminHandlers.addCronJob(makeCtx(), {
      cronExpr: "not a cron",
      prompt: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Invalid cron expression");
  });

  test("addCronJob creates with defaults and reports next run", async () => {
    const res = await adminHandlers.addCronJob(makeCtx(), {
      cronExpr: "0 9 * * 1-5",
      prompt: "daily standup",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Cron job created");
    expect(res.content[0]!.text).toContain("[thread, when_active=fire]");
    const jobs = CronJobs.listActive();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.createdBy).toBe(MANAGER);
    expect(jobs[0]!.slackChannelId).toBe("C0COV001");
    expect(jobs[0]!.slackTeamId).toBe("T0COV001");
  });

  test("addCronJob honors target and when_active", async () => {
    const res = await adminHandlers.addCronJob(makeCtx(), {
      cronExpr: "*/30 * * * *",
      prompt: "broadcast",
      target: "channel",
      whenActive: "skip",
    });
    expect(res.content[0]!.text).toContain("[channel, when_active=skip]");
  });

  test("removeCronJob denied for non-manager", async () => {
    const res = await adminHandlers.removeCronJob(makeCtx({ userId: RANDO }), { jobId: "deadbeef" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Only manager or approver");
  });

  test("removeCronJob not found", async () => {
    const res = await adminHandlers.removeCronJob(makeCtx(), { jobId: "deadbeef" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("not found");
  });

  test("removeCronJob deactivates by 8-char prefix", async () => {
    const job = CronJobs.create({
      channelId: "C1",
      createdBy: MANAGER,
      cronExpr: "0 9 * * *",
      prompt: "remove me",
      nextRunAt: Date.now(),
    });
    const res = await adminHandlers.removeCronJob(makeCtx(), { jobId: job.id.slice(0, 8) });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("deactivated");
    expect(CronJobs.listActive()).toHaveLength(0);
  });

  test("removeCronJob surfaces ambiguous-prefix error", async () => {
    const insert = (id: string) =>
      db.run(
        `INSERT INTO cron_jobs (id, slack_team_id, slack_channel_id, slack_thread_ts, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, target, when_active, active)
         VALUES (?, NULL, NULL, NULL, 'C1', NULL, ?, '0 9 * * *', 'p', ?, 'thread', 'fire', 1)`,
        [id, MANAGER, Date.now()],
      );
    insert("aaaabbbb-0000-4000-8000-000000000001");
    insert("aaaabbbb-0000-4000-8000-000000000002");
    const res = await adminHandlers.removeCronJob(makeCtx(), { jobId: "aaaabbbb" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("matches multiple jobs");
  });
});

describe("adminHandlers triggerIngest", () => {
  test("denied for non-manager", async () => {
    const res = await adminHandlers.triggerIngest(makeCtx({ userId: RANDO }));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Only manager or approver");
  });

  test("surfaces ingest failure reason (no manifest in test home)", async () => {
    const res = await adminHandlers.triggerIngest(makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Ingest failed");
  });
});

describe("adminHandlers thread ignores", () => {
  test("ignoreThread denied for non-manager", async () => {
    const res = await adminHandlers.ignoreThread(makeCtx({ userId: RANDO }), {
      duration: "5m",
      reason: "noise",
    });
    expect(res.isError).toBe(true);
  });

  test("ignoreThread rejects bad duration", async () => {
    const res = await adminHandlers.ignoreThread(makeCtx(), { duration: "soon", reason: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("duration must be like");
  });

  test("ignoreThread timed creates expiring record", async () => {
    const ctx = makeCtx();
    const res = await adminHandlers.ignoreThread(ctx, { duration: "5m", reason: "drift" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("ignored for 5m");
    const rec = Ignores.findActiveForThread(ctx.channel, ctx.threadTs);
    expect(rec).not.toBeNull();
    expect(rec!.expiresAt).toBeGreaterThan(Date.now());
    expect(rec!.reason).toBe("drift");
  });

  test("ignoreThread permanent has no expiry and replaces prior ignore", async () => {
    const ctx = makeCtx();
    await adminHandlers.ignoreThread(ctx, { duration: "5m", reason: "first" });
    const res = await adminHandlers.ignoreThread(ctx, { duration: "permanent", reason: "second" });
    expect(res.content[0]!.text).toContain("ignored permanently");
    const rec = Ignores.findActiveForThread(ctx.channel, ctx.threadTs);
    expect(rec!.expiresAt).toBeNull();
    expect(rec!.reason).toBe("second");
  });

  test("unignoreThread denied for non-manager", async () => {
    const res = await adminHandlers.unignoreThread(makeCtx({ userId: RANDO }));
    expect(res.isError).toBe(true);
  });

  test("unignoreThread with nothing active", async () => {
    const res = await adminHandlers.unignoreThread(makeCtx());
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("no active ignore for this thread");
  });

  test("unignoreThread removes active ignore", async () => {
    const ctx = makeCtx();
    await adminHandlers.ignoreThread(ctx, { duration: "1h", reason: "x" });
    const res = await adminHandlers.unignoreThread(ctx);
    expect(res.content[0]!.text).toContain("Thread ignore removed");
    expect(Ignores.findActiveForThread(ctx.channel, ctx.threadTs)).toBeNull();
  });
});

describe("adminHandlers user ignores", () => {
  test("ignoreUser denied for non-manager", async () => {
    const res = await adminHandlers.ignoreUser(makeCtx({ userId: RANDO }), {
      userId: "U_TARGET",
      duration: "5m",
      reason: "spam",
    });
    expect(res.isError).toBe(true);
  });

  test("ignoreUser rejects bad duration", async () => {
    const res = await adminHandlers.ignoreUser(makeCtx(), {
      userId: "U_TARGET",
      duration: "99x",
      reason: "spam",
    });
    expect(res.isError).toBe(true);
  });

  test("ignoreUser timed", async () => {
    const res = await adminHandlers.ignoreUser(makeCtx(), {
      userId: "U_TARGET",
      duration: "1h",
      reason: "spam",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("<@U_TARGET> ignored for 1h");
    const rec = Ignores.findActiveForUser("U_TARGET");
    expect(rec).not.toBeNull();
    expect(rec!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("ignoreUser permanent", async () => {
    const res = await adminHandlers.ignoreUser(makeCtx(), {
      userId: "U_TARGET",
      duration: "permanent",
      reason: "blocked",
    });
    expect(res.content[0]!.text).toContain("ignored permanently");
    expect(Ignores.findActiveForUser("U_TARGET")!.expiresAt).toBeNull();
  });

  test("unignoreUser denied for non-manager", async () => {
    const res = await adminHandlers.unignoreUser(makeCtx({ userId: RANDO }), { userId: "U_TARGET" });
    expect(res.isError).toBe(true);
  });

  test("unignoreUser with nothing active", async () => {
    const res = await adminHandlers.unignoreUser(makeCtx(), { userId: "U_TARGET" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("no active ignore for user <@U_TARGET>");
  });

  test("unignoreUser removes active ignore", async () => {
    await adminHandlers.ignoreUser(makeCtx(), {
      userId: "U_TARGET",
      duration: "5m",
      reason: "x",
    });
    const res = await adminHandlers.unignoreUser(makeCtx(), { userId: "U_TARGET" });
    expect(res.content[0]!.text).toContain("stopped ignoring <@U_TARGET>");
    expect(Ignores.findActiveForUser("U_TARGET")).toBeNull();
  });
});

describe("adminHandlers reloadSession", () => {
  test("denied for non-manager", async () => {
    const res = await adminHandlers.reloadSession(makeCtx({ userId: RANDO }));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Only manager or approver");
  });

  test("errors when reload not wired", async () => {
    const res = await adminHandlers.reloadSession(makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("reload not wired");
  });

  test("errors when session not live", async () => {
    const res = await adminHandlers.reloadSession(makeCtx({ reloadSession: () => false }));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("session not live");
  });

  test("reloads live session", async () => {
    const res = await adminHandlers.reloadSession(makeCtx({ reloadSession: () => true }));
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Session reloaded");
  });
});
