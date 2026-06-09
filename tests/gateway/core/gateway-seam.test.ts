import { describe, it, expect } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

/** Transport that records `chat.postMessage` calls and captures registered event
 *  handlers so a test can drive an inbound Slack message through the gateway. */
function capturingTransport(): { t: Transport; posts: any[]; emit: (name: string, args: any) => Promise<void> } {
  const posts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, posts, emit };
}

describe("createGateway", () => {
  it("returns a handle with start/stop/__sessionCtx", () => {
    const h = createGateway(new AgentManager(), fakeTransport());
    expect(typeof h.start).toBe("function");
    expect(typeof h.stop).toBe("function");
    expect(h.__sessionCtx("nope")).toBeUndefined();
  });

  // Regression: the cron scheduler starts during construction and synchronously
  // runs a due job through onExecute (which references the `routes` map) before the
  // first await. If `routes` is declared after `cronScheduler.start()`, that reference
  // hits a TDZ. Because `#execute` is async, the throw surfaces as an UNHANDLED
  // REJECTION ("Cannot access 'routes' before initialization"), not a sync throw — and
  // a due cron job at boot is normal, so this crashes the agent's cron path on restart.
  it("does not hit a routes TDZ when a due cron job exists at boot", async () => {
    db.run("DELETE FROM cron_jobs");
    CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C1",
      channelId: "C1",
      createdBy: "U1",
      cronExpr: "* * * * *",
      prompt: "x",
      nextRunAt: Date.now() - 1000,
      target: "channel",
    });
    const rejections: string[] = [];
    const onRej = (e: any) => rejections.push(String(e?.message ?? e));
    process.on("unhandledRejection", onRej);

    const agent = new AgentManager();
    agent.sendMessage = async () => {}; // stub: don't fire a real agent turn
    const h = createGateway(agent, fakeTransport());
    await new Promise((r) => setTimeout(r, 50)); // flush scheduler tick + microtasks

    process.off("unhandledRejection", onRej);
    h.stop();
    db.run("DELETE FROM cron_jobs");

    expect(rejections.find((m) => m.includes("routes"))).toBeUndefined();
  });

  // Drive `/cron-add "<expr>" "<prompt>" channel` from the manager through the gateway's
  // message router (a DM) and assert the channel-target wiring: a CronJob is persisted with
  // target "channel", and the confirmation reply says it posts to channel root.
  it("creates a channel-target cron from /cron-add ... channel and confirms channel-root posting", async () => {
    db.run("DELETE FROM cron_jobs");
    writeSoulFixture(WORLD); // manager = U0MGR

    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);

    await emit("message", {
      event: {
        type: "message",
        channel: "D_MGR",
        channel_type: "im",
        user: WORLD.manager,
        team: "T",
        ts: "100.1",
        text: '/cron-add "0 9 * * 1" "weekly digest" channel',
      },
      client: t.client,
      context: { teamId: "T" },
    });

    const jobs = CronJobs.listActive();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.target).toBe("channel");
    expect(jobs[0]!.slackThreadTs).toBeNull();

    const confirm = posts.find((p) => String(p.text).includes("cron job created"));
    expect(confirm).toBeDefined();
    expect(String(confirm.text)).toContain("channel root");

    // /cron-list renders the [channel] target tag.
    await emit("message", {
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts: "100.2", text: "/cron-list" },
      client: t.client,
      context: { teamId: "T" },
    });
    const listing = posts.find((p) => String(p.text).includes("Active cron jobs"));
    expect(listing).toBeDefined();
    expect(String(listing.text)).toContain("[channel]");

    db.run("DELETE FROM cron_jobs");
  });
});
