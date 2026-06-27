import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
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

  test("findByPrefix returns job for 8-char prefix", () => {
    const job = CronJobs.create({ channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now() });
    const found = CronJobs.findByPrefix(job.id.slice(0, 8));
    expect(found?.id).toBe(job.id);
  });

  test("findByPrefix falls back to exact match for non-8-char", () => {
    const job = CronJobs.create({ channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now() });
    const found = CronJobs.findByPrefix(job.id);
    expect(found?.id).toBe(job.id);
  });

  test("findByPrefix returns null when no match", () => {
    CronJobs.create({ channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now() });
    expect(CronJobs.findByPrefix("zzzzzzzz")).toBeNull();
  });

  test("defaults target to thread", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
    });
    expect(job.target).toBe("thread");
  });

  test("persists channel target", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
      target: "channel",
    });
    expect(job.target).toBe("channel");
    expect(CronJobs.findById(job.id)!.target).toBe("channel");
  });

  test("defaults whenActive to fire", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
    });
    expect(job.whenActive).toBe("fire");
  });

  test("persists whenActive skip", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
      whenActive: "skip",
    });
    expect(job.whenActive).toBe("skip");
    expect(CronJobs.findById(job.id)!.whenActive).toBe("skip");
  });

  test("pause hides due scheduled job until resume", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: now - 1000,
    });
    CronJobs.pause(job.id);
    expect(CronJobs.findById(job.id)!.paused).toBe(1);
    expect(CronJobs.findDue(now)).toHaveLength(0);
    CronJobs.resume(job.id, now + 60_000);
    const resumed = CronJobs.findById(job.id)!;
    expect(resumed.paused).toBe(0);
    expect(resumed.nextRunAt).toBe(now + 60_000);
  });

  test("defaults oauthUser to null", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
    });
    expect(job.oauthUser).toBeNull();
    expect(CronJobs.findById(job.id)!.oauthUser).toBeNull();
  });

  test("persists oauthUser (1on1 lock owner)", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
      oauthUser: "Uowner",
    });
    expect(job.oauthUser).toBe("Uowner");
    expect(CronJobs.findById(job.id)!.oauthUser).toBe("Uowner");
  });

  test("updates editable cron fields", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: now,
    });
    CronJobs.update(job.id, {
      cronExpr: "30 9 * * 1",
      prompt: "weekly",
      nextRunAt: now + 60_000,
      target: "channel",
      whenActive: "skip",
    });
    const updated = CronJobs.findById(job.id)!;
    expect(updated.cronExpr).toBe("30 9 * * 1");
    expect(updated.prompt).toBe("weekly");
    expect(updated.nextRunAt).toBe(now + 60_000);
    expect(updated.target).toBe("channel");
    expect(updated.whenActive).toBe("skip");
  });
});

describe("CronScheduler", () => {
  // Isolate from other test files: a due job left in the shared DB would be picked up
  // by any later gateway construction and fire a stray cron run. Clean before & after.
  beforeEach(() => db.run("DELETE FROM cron_jobs"));
  afterEach(() => db.run("DELETE FROM cron_jobs"));

  test("starts and stops without error", () => {
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {} } as any,
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
      agent: { ensureSession: () => ({ id: "test" }), sendMessage, isLive: () => false, on: () => {}, off: () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  test("tick skips legacy job without Slack keys", async () => {
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
      agent: { ensureSession: () => ({ id: "test" }), sendMessage, isLive: () => false, on: () => {}, off: () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(0);
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toMatch(/^error: missing Slack keys/);
  });

  test("tick skips a passive job (when_active=skip) when the session is live", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
      whenActive: "skip",
    });
    const sendMessage = mock(async () => {});
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "sess-1" }), sendMessage, isLive: () => true, on: () => {}, off: () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(0);
    expect(CronJobs.findById(job.id)!.lastResult).toBe("skipped: session live");
  });

  test("tick fires even when the session is live (cron runs by default)", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const sendMessage = mock(async () => {});
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "sess-1" }), sendMessage, isLive: () => true, on: () => {}, off: () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    // A live session no longer suppresses the cron — it dispatches regardless.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).not.toBe("skipped: session live");
  });

  test("tick does not execute paused scheduled job", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "paused",
      nextRunAt: now - 1000,
    });
    CronJobs.pause(job.id);
    const sendMessage = mock(async () => {});
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "sess-1" }), sendMessage, isLive: () => false, on: () => {}, off: () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  test("tick executes due job with Slack keys and waits for done event", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const sendMessage = mock(async () => {});
    const eventHandlers = new Map<string, Function[]>();
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-1" }),
        sendMessage,
        isLive: () => false,
        on: (evt: string, fn: Function) => {
          if (!eventHandlers.has(evt)) eventHandlers.set(evt, []);
          eventHandlers.get(evt)!.push(fn);
        },
        off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // next_run not yet updated — waiting for done event
    const mid = CronJobs.findById(job.id);
    expect(mid!.lastResult).not.toBe("completed");
    // Simulate done event (AgentManager emits "event" payloads)
    for (const fn of eventHandlers.get("event") ?? []) fn({ type: "done", sessionId: "sess-1" });
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toBe("completed");
    expect(updated!.nextRunAt).toBeGreaterThan(now);
  });

  test("tick handles sendMessage error immediately", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
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
        isLive: () => false,
        on: () => {},
        off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toMatch(/^error:/);
  });

  test("tick handles agent error event", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C123",
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "fail",
      nextRunAt: now - 1000,
    });
    const eventHandlers = new Map<string, Function[]>();
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-1" }),
        sendMessage: async () => {},
        isLive: () => false,
        on: (evt: string, fn: Function) => {
          if (!eventHandlers.has(evt)) eventHandlers.set(evt, []);
          eventHandlers.get(evt)!.push(fn);
        },
        off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    // Simulate error event for this session (AgentManager emits "event" payloads)
    for (const fn of eventHandlers.get("event") ?? []) fn({ type: "error", sessionId: "sess-1", error: "agent crashed" });
    const updated = CronJobs.findById(job.id);
    expect(updated!.lastResult).toMatch(/^error: agent crashed/);
  });

  test("channel-target job keys session on cron:id even with slackThreadTs set", async () => {
    db.run("DELETE FROM cron_jobs");
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123", slackThreadTs: "999.999",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: now - 1000, target: "channel",
    });
    let capturedKey: any = null;
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: (key: any) => { capturedKey = key; return { id: "sess-1" }; },
        sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(capturedKey.thread_ts).toBe(`cron:${job.id}`);
  });

  test("job created in a 1on1 hands the lock owner to the agent before sending", async () => {
    db.run("DELETE FROM cron_jobs");
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: now - 1000, target: "channel",
      oauthUser: "Uowner",
    });
    const calls: Array<{ fn: string; args: any[] }> = [];
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-cron" }),
        setCronOAuthUser: (...args: any[]) => calls.push({ fn: "setCronOAuthUser", args }),
        sendMessage: async (...args: any[]) => { calls.push({ fn: "sendMessage", args }); },
        isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    // Override must be set on the run's session, before the message is sent.
    expect(calls[0]).toEqual({ fn: "setCronOAuthUser", args: ["sess-cron", "Uowner"] });
    expect(calls[1]?.fn).toBe("sendMessage");
    void job;
  });

  test("job created outside a 1on1 never sets an OAuth override", async () => {
    db.run("DELETE FROM cron_jobs");
    const now = Date.now();
    CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: now - 1000, target: "channel",
    });
    const setCronOAuthUser = mock(() => {});
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: () => ({ id: "sess-cron" }),
        setCronOAuthUser,
        sendMessage: async () => {},
        isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(setCronOAuthUser).toHaveBeenCalledTimes(0);
  });

  test("thread-target job keys session on slackThreadTs", async () => {
    db.run("DELETE FROM cron_jobs");
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123", slackThreadTs: "888.888",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "watch", nextRunAt: now - 1000, target: "thread",
    });
    let capturedKey: any = null;
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: (key: any) => { capturedKey = key; return { id: "sess-2" }; },
        sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(capturedKey.thread_ts).toBe("888.888");
    void job;
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
