import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { paths } from "../../../src/config/home";
import { SimSession } from "../../../src/gateway/sim/engine";
import * as Sessions from "../../../src/db/sessions";

// Regression coverage for docs/findings/2026-07-03-cron-private-mcp-scoping-drift.md:
// mcpResolver used to re-derive privacy purely from the live /1on1 lock, ignoring
// job.oauthUser. Channel-target cron jobs (synthetic `cron:<id>` thread) never
// matched a lock, so whitelisted privateServices always mounted with real creds;
// thread-target jobs picked up whatever lock the thread holds *now*, not the
// identity captured at job creation.
const MCP_PATH = join(paths.home, ".mcp.json");

function writeMcp() {
  writeFileSync(
    MCP_PATH,
    JSON.stringify({
      mcpServers: { demo: { command: "demo-server", args: [], env: { SECRET: "agent-token" } } },
      privateServices: ["demo"],
    }),
    "utf8",
  );
}

function makeGw(agent: AgentManager) {
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  } as any;
  const t = {
    client,
    action: () => {},
    event: () => {},
    use: () => {},
    start: async () => {},
    stop: async () => {},
  } as any;
  agent.sendMessage = async () => {};
  return createGateway(agent, t);
}

afterEach(async () => {
  db.run("DELETE FROM cron_jobs");
  OneOnOne._wipeForTests();
  try { rmSync(MCP_PATH, { force: true }); } catch {}
});

describe("cron private-MCP credential scoping honors job.oauthUser", () => {
  it("channel-target cron job strips creds for whitelisted services when oauthUser is set", async () => {
    writeSoulFixture(WORLD);
    writeMcp();
    const agent = new AgentManager();

    // Job must exist before the gateway (and its scheduler) is constructed —
    // scheduler.start() fires its first tick synchronously at construction time.
    const job = CronJobs.create({
      slackTeamId: "T",
      slackChannelId: "C0TEAM",
      channelId: "C0TEAM",
      createdBy: WORLD.manager,
      cronExpr: "* * * * *",
      prompt: "tick",
      nextRunAt: Date.now() - 1000,
      target: "channel",
      oauthUser: "U_INITIATOR",
    });

    const h = makeGw(agent);
    // The due job runs through onExecute, which registers the route and calls
    // setCronOAuthUser(session, job.oauthUser).
    await new Promise((r) => setTimeout(r, 80));

    const session = agent.ensureSession({ team_id: "T", channel_id: "C0TEAM", thread_ts: `cron:${job.id}` });
    // No /1on1 lock exists for the synthetic cron thread — only job.oauthUser
    // carries the initiator's identity.
    expect(OneOnOne.find("C0TEAM", `cron:${job.id}`)).toBeNull();

    const servers = h.__resolveMcp(session.id)!;
    expect((servers.demo as any).env).toEqual({});
    expect((servers.demo as any).command).toBe("demo-server");
  });

  it("thread-target cron job prefers the captured initiator over the thread's live lock state", async () => {
    writeSoulFixture(WORLD);
    writeMcp();
    const agent = new AgentManager();

    const threadTs = "T-CRON-THREAD";
    CronJobs.create({
      slackTeamId: "T",
      slackChannelId: "C0TEAM",
      slackThreadTs: threadTs,
      channelId: "C0TEAM",
      createdBy: WORLD.manager,
      cronExpr: "* * * * *",
      prompt: "tick",
      nextRunAt: Date.now() - 1000,
      target: "thread",
      oauthUser: "U_INITIATOR",
    });

    const h = makeGw(agent);
    await new Promise((r) => setTimeout(r, 80));

    // Thread is unlocked live — old code re-derived privacy from OneOnOne.find
    // alone and would have mounted creds unstripped here.
    expect(OneOnOne.find("C0TEAM", threadTs)).toBeNull();

    const session = agent.ensureSession({ team_id: "T", channel_id: "C0TEAM", thread_ts: threadTs });
    const servers = h.__resolveMcp(session.id)!;
    expect((servers.demo as any).env).toEqual({});
  });

  it("ordinary interactive session (no cronOAuthUser) still keys purely off the live lock", async () => {
    writeMcp();
    const s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    try {
      s.thread = "T-INTERACTIVE";
      await s.send({ text: "hello" });
      const row = Sessions.findByThread({ team_id: "T0SIM", channel_id: "C0TEAM", thread_ts: "T-INTERACTIVE" });
      const sid = row!.id;

      let servers = s.handle.__resolveMcp(sid)!;
      expect((servers.demo as any).env).toEqual({ SECRET: "agent-token" });

      await s.send({ text: "/1on1" });
      servers = s.handle.__resolveMcp(sid)!;
      expect((servers.demo as any).env).toEqual({});
    } finally {
      await s.dispose();
    }
  });
});
