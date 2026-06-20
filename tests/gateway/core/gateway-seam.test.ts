import { describe, it, expect } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as MentionOnly from "../../../src/db/mention-only";
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
function capturingTransport(): { t: Transport; posts: any[]; reacts: any[]; emit: (name: string, args: any) => Promise<void> } {
  const posts: any[] = [];
  const reacts: any[] = []; // every reactions.add (so a test can see ✅/👀/⚙️ stamping)
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
      reactions: { add: async (a: any) => { reacts.push(a); return { ok: true }; }, remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, posts, reacts, emit };
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

  describe("/soul runtime overrides", () => {
    const dm = (ts: string, text: string, user = WORLD.manager, channel = "D_MGR") => ({
      event: { type: "message", channel, channel_type: "im", user, team: "T", ts, text },
      context: { teamId: "T" },
    });
    const newGw = () => {
      const cap = capturingTransport();
      const agent = new AgentManager();
      const sends: string[] = [];
      agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
      createGateway(agent, cap.t);
      return { ...cap, sends };
    };

    it("manager adds an allowed channel — gate opens on the next message (immediacy)", async () => {
      db.run("DELETE FROM sessions");
      db.run("DELETE FROM soul_overrides");
      process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
      writeSoulFixture(WORLD);
      const g = newGw();

      // C0FRESH is not in the soul fixture: a non-manager mention there drops at the whitelist gate.
      const fresh = (ts: string, text: string) => ({
        event: { type: "message", channel: "C0FRESH", channel_type: "channel", user: "U0RANDO", team: "T", ts, text },
        context: { teamId: "T" }, client: g.t.client,
      });
      const mention = async (ts: string) => {
        const a = fresh(ts, "<@U_SLAUDE> hi");
        await g.emit("app_mention", { ...a, event: { ...a.event, type: "app_mention" } });
        await g.emit("message", a);
      };
      await mention("600.1");
      expect(g.sends.length).toBe(0); // unlisted channel, non-manager → dropped

      await g.emit("message", { ...dm("600.2", "/soul allow add C0FRESH"), client: g.t.client });
      const confirm = g.posts.find((p) => String(p.text).includes("C0FRESH"));
      expect(confirm).toBeDefined();

      await mention("600.3");
      expect(g.sends.length).toBe(1); // gate open, no reload needed
    });

    it("non-manager /soul refused — backup manager too — store untouched", async () => {
      db.run("DELETE FROM soul_overrides");
      writeSoulFixture(WORLD);
      const g = newGw();

      await g.emit("message", { ...dm("601.1", "/soul allow add C0NOPE", WORLD.backup, "D_BCK"), client: g.t.client });
      const refusal = g.posts.find((p) => String(p.text).includes("manager-only"));
      expect(refusal).toBeDefined();
      const { list } = await import("../../../src/db/soul-overrides");
      expect(list().length).toBe(0);
    });

    it("/soul block add drops the user's next message; /soul clear reverts", async () => {
      db.run("DELETE FROM sessions");
      db.run("DELETE FROM soul_overrides");
      writeSoulFixture(WORLD);
      const g = newGw();

      const teamMsg = async (ts: string, user: string) => {
        const a = { event: { type: "message", channel: WORLD.trusted[0]!, channel_type: "channel", user, team: "T", ts, text: "<@U_SLAUDE> hello" }, context: { teamId: "T" }, client: g.t.client };
        await g.emit("app_mention", { ...a, event: { ...a.event, type: "app_mention" } });
        await g.emit("message", a);
      };
      await teamMsg("602.1", "U0NOISY");
      expect(g.sends.length).toBe(1); // trusted channel: anyone can chat

      await g.emit("message", { ...dm("602.2", "/soul block add <@U0NOISY>"), client: g.t.client });
      await teamMsg("602.3", "U0NOISY");
      expect(g.sends.length).toBe(1); // blocked → dropped

      await g.emit("message", { ...dm("602.4", "/soul clear block"), client: g.t.client });
      await teamMsg("602.5", "U0NOISY");
      expect(g.sends.length).toBe(2); // unblocked → flows again
    });
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
    // A disengaged message is no longer dropped — it's forwarded to the session
    // (so the transcript stays populated) but tagged "recorded for context only"
    // so the UserPromptSubmit hook suppresses it (no model run, no reply). The
    // agent.sendMessage stub bypasses the real hook, so we classify by envelope:
    // a processed turn carries the reply directive; a suppressed turn does not.
    const isSuppressed = (env: string) => env.includes("do NOT reply");
    const newGateway = () => {
      const cap = capturingTransport();
      const agent = new AgentManager();
      const sends: string[] = [];
      agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
      const processed = () => sends.filter((s) => !isSuppressed(s));
      const suppressed = () => sends.filter((s) => isSuppressed(s));
      createGateway(agent, cap.t);
      // Engage the way real Slack does: a bot mention fires app_mention (the
      // fixture bot id U_SLAUDE has an underscore, so the message-event mention
      // regex can't engage on its own — same landmine as mcp-connect.test.ts).
      const mention = async (ts: string, text: string, thread?: string) => {
        const args = { ...mk(ts, text, thread), client: cap.t.client };
        await cap.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
        await cap.emit("message", args);
      };
      return { ...cap, agent, sends, mention, processed, suppressed };
    };
    const wipe = () => {
      db.run("DELETE FROM sessions");
      // handleMessage's attachment download resolves the bot token lazily.
      process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
    };

    it("mention-only thread: plain follow-up recorded-but-suppressed, @mention still replies", async () => {
      wipe();
      MentionOnly._wipeForTests();
      writeSoulFixture(WORLD);
      const g = newGateway();
      const thread = "300.1";

      await g.mention(thread, "<@U_SLAUDE> hello");
      expect(g.processed().length).toBe(1); // engaged, session row exists

      MentionOnly.set({ channelId: CH, threadTs: thread, createdBy: WORLD.manager });

      // plain follow-up (no @mention) → recorded-suppressed, NOT processed, no reply
      await g.emit("message", { ...mk("300.2", "just a plain follow-up", thread), client: g.t.client });
      expect(g.processed().length).toBe(1);  // no new processed turn
      expect(g.suppressed().length).toBe(1); // recorded for context

      // an @mention still replies (mention-only stays set)
      await g.mention("300.3", "<@U_SLAUDE> ping", thread);
      expect(g.processed().length).toBe(2);
      expect(MentionOnly.find(CH, thread)).not.toBeNull();

      // mention-only on a thread with NO session → plain message is dropped
      // outright (nothing to record), not suppressed.
      const fresh = "301.1";
      MentionOnly.set({ channelId: CH, threadTs: fresh, createdBy: WORLD.manager });
      const before = g.processed().length + g.suppressed().length;
      await g.emit("message", { ...mk("301.2", "plain, no session", fresh), client: g.t.client });
      expect(g.processed().length + g.suppressed().length).toBe(before); // dropped
    });

    it("disengaged messages are recorded-but-suppressed, never processed (no reply)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();

      await g.mention("200.1", "<@U_SLAUDE> hello");
      expect(g.processed().length).toBe(1); // engaged + handled, session row now exists
      expect(g.suppressed().length).toBe(0);

      await g.emit("message", { ...mk("200.2", "<@U0APP> can you take this?", "200.1"), client: g.t.client });
      // mention-other: thread disengages, but the message is recorded (suppressed),
      // not dropped — the transcript stays populated for re-engage.
      expect(g.processed().length).toBe(1); // still no new *processed* turn
      expect(g.suppressed().length).toBe(1);

      await g.emit("message", { ...mk("200.3", "sure, on it", "200.1"), client: g.t.client });
      // plain reply after disengage: recorded (suppressed), still not processed.
      expect(g.processed().length).toBe(1);
      expect(g.suppressed().length).toBe(2);
    });

    it("mention-other with NO session is dropped (never spins one up)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();
      // No prior engagement → no session row. A colleague-mention here must not
      // create a session or record anything.
      await g.emit("message", { ...mk("250.1", "<@U0APP> hey can you help", "250.1"), client: g.t.client });
      expect(g.sends.length).toBe(0);
    });

    it("disengage survives a gateway restart (recorded-suppressed, not processed)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g1 = newGateway();
      await g1.mention("300.1", "<@U_SLAUDE> hello");
      await g1.emit("message", { ...mk("300.2", "<@U0APP> over to you", "300.1"), client: g1.t.client });
      expect(g1.processed().length).toBe(1);

      const g2 = newGateway(); // fresh in-memory engagement set
      await g2.emit("message", { ...mk("300.3", "thanks!", "300.1"), client: g2.t.client });
      // restore path must respect the persisted disengage: recorded, not processed.
      expect(g2.processed().length).toBe(0);
      expect(g2.suppressed().length).toBe(1);
    });

    it("re-mentioning the bot re-engages durably (plain replies handled again)", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();
      await g.mention("400.1", "<@U_SLAUDE> hello");
      await g.emit("message", { ...mk("400.2", "<@U0APP> fyi", "400.1"), client: g.t.client });
      await g.mention("400.3", "<@U_SLAUDE> back to you", "400.1");
      expect(g.processed().length).toBe(2); // both bot-mentions processed
      expect(g.suppressed().length).toBe(1); // the colleague-mention was recorded

      const g2 = newGateway(); // restart: re-engage must have been persisted too
      await g2.emit("message", { ...mk("400.4", "continue please", "400.1"), client: g2.t.client });
      expect(g2.processed().length).toBe(1);
      expect(g2.suppressed().length).toBe(0);
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

    // The agent-event `done` handler must skip its ✅/status cleanup for a
    // suppressed (disengaged) turn — that message was recorded but never
    // processed, so there's no 👀 to clear and stamping ✅ would be wrong.
    it("a suppressed (disengaged) done short-circuits — no ✅ stamped", async () => {
      wipe();
      writeSoulFixture(WORLD);
      const g = newGateway();
      const tick = () => new Promise((r) => setTimeout(r, 20));
      const doneCount = () => g.reacts.filter((r) => r.name === "white_check_mark").length;

      // Engage → route exists with suppress=false. A done event stamps ✅.
      await g.mention("700.1", "<@U_SLAUDE> hello");
      const row = Sessions.findByThread({ team_id: "T", channel_id: CH, thread_ts: "700.1" });
      expect(row).not.toBeNull();
      g.agent.emit("event", { type: "done", sessionId: row!.id } as any);
      await tick();
      expect(doneCount()).toBe(1); // engaged turn cleaned up normally

      // Disengage (colleague mention) → same route flips to suppress=true.
      await g.emit("message", { ...mk("700.2", "<@U0APP> your turn", "700.1"), client: g.t.client });
      g.agent.emit("event", { type: "done", sessionId: row!.id } as any);
      await tick();
      expect(doneCount()).toBe(1); // suppressed done short-circuited — no new ✅
    });
  });
});
