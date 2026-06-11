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

  // Engagement lifecycle: disengage (mention of another user) must stick — across
  // both the next plain reply (session-row restore path) and a gateway restart
  // (in-memory engagement set wiped). Regression for the "agent keeps replying
  // after I started talking to a colleague" bug.
  describe("engage/disengage durability", () => {
    const CH = WORLD.trusted[0]!; // trusted channel: anyone can address slaude
    const mk = (ts: string, text: string, thread?: string) => ({
      event: { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: "T", ts, text, ...(thread ? { thread_ts: thread } : {}) },
      context: { teamId: "T" },
    });
    const newGateway = () => {
      const cap = capturingTransport();
      const agent = new AgentManager();
      const sends: string[] = [];
      agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
      createGateway(agent, cap.t);
      // Engage the way real Slack does: a bot mention fires app_mention (the
      // fixture bot id U_SLAUDE has an underscore, so the message-event mention
      // regex can't engage on its own — same landmine as mcp-connect.test.ts).
      const mention = async (ts: string, text: string, thread?: string) => {
        const args = { ...mk(ts, text, thread), client: cap.t.client };
        await cap.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
        await cap.emit("message", args);
      };
      return { ...cap, sends, mention };
    };
    const wipe = () => {
      db.run("DELETE FROM sessions");
      // handleMessage's attachment download resolves the bot token lazily.
      process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
    };

    it("disengage survives the session-row restore path (next plain reply stays dropped)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();

      await g.mention("200.1", "<@U_SLAUDE> hello");
      expect(g.sends.length).toBe(1); // engaged + handled, session row now exists

      await g.emit("message", { ...mk("200.2", "<@U0APP> can you take this?", "200.1"), client: g.t.client });
      expect(g.sends.length).toBe(1); // mention-other: dropped + disengaged

      await g.emit("message", { ...mk("200.3", "sure, on it", "200.1"), client: g.t.client });
      expect(g.sends.length).toBe(1); // plain reply after disengage must NOT be handled
    });

    it("disengage survives a gateway restart (engagement set wiped, db restores state)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g1 = newGateway();
      await g1.mention("300.1", "<@U_SLAUDE> hello");
      await g1.emit("message", { ...mk("300.2", "<@U0APP> over to you", "300.1"), client: g1.t.client });
      expect(g1.sends.length).toBe(1);

      const g2 = newGateway(); // fresh in-memory engagement set
      await g2.emit("message", { ...mk("300.3", "thanks!", "300.1"), client: g2.t.client });
      expect(g2.sends.length).toBe(0); // restore path must respect the persisted disengage
    });

    it("re-mentioning the bot re-engages durably (plain replies handled again)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();
      await g.mention("400.1", "<@U_SLAUDE> hello");
      await g.emit("message", { ...mk("400.2", "<@U0APP> fyi", "400.1"), client: g.t.client });
      await g.mention("400.3", "<@U_SLAUDE> back to you", "400.1");
      expect(g.sends.length).toBe(2);

      const g2 = newGateway(); // restart: re-engage must have been persisted too
      await g2.emit("message", { ...mk("400.4", "continue please", "400.1"), client: g2.t.client });
      expect(g2.sends.length).toBe(1);
    });

    it("restart restore still works for engaged threads (no re-mention needed)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g1 = newGateway();
      await g1.mention("500.1", "<@U_SLAUDE> hello");
      expect(g1.sends.length).toBe(1);

      const g2 = newGateway();
      await g2.emit("message", { ...mk("500.2", "still there?", "500.1"), client: g2.t.client });
      expect(g2.sends.length).toBe(1);
    });
  });
});
