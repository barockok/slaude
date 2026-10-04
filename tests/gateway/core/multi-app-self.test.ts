/**
 * D1.2/D1.4 with two registered apps in one channel. Slack delivers every
 * channel message to every app installed there, so:
 *   - app A's own reply also arrives through app B; it is still our echo, or
 *     the two bots answer each other (R2-1);
 *   - a mention of B's bot is answered by B (through B's delivery) and not by A;
 *   - a plain reply in a thread recorded under A is continued by A only.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const BOT = { A0ONE: { user: "U0BOTA", bot: "B0BOTA" }, A0TWO: { user: "U0BOTB", bot: "B0BOTB" } } as const;
type AppId = keyof typeof BOT;

function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const calls: string[] = [];
  const clientOf = (app: AppId): any => ({
    auth: { test: async () => ({ user_id: BOT[app].user, bot_id: BOT[app].bot, team: "T", url: "x" }) },
    chat: { postMessage: async () => (calls.push(`post:${app}`), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => (calls.push(`react:${app}`), { ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => (calls.push(`status:${app}`), { ok: true }) } },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  });
  const clients = { A0ONE: clientOf("A0ONE"), A0TWO: clientOf("A0TWO") };
  const t: Transport = {
    client: clients.A0ONE, // the oldest app, as in HTTP mode
    clientFor: (app: AppRef) => clients[(app.apiAppId ?? "A0ONE") as AppId],
    apps: async () =>
      (Object.keys(clients) as AppId[]).map((id) => ({ apiAppId: id, teamId: "T", botUserId: BOT[id].user, client: clients[id] })),
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const agent = new AgentManager();
  const turns: string[] = [];
  agent.sendMessage = async (id: string) => void turns.push(id);
  createGateway(agent, t);
  /** Deliver one message event through `app`. */
  const deliver = (app: AppId, event: Record<string, unknown>) =>
    handlers.get("message")!({
      event: { type: "message", channel: "C0TEAM", channel_type: "channel", team: "T", ...event },
      client: clients[app],
      context: { teamId: "T", apiAppId: app, botUserId: BOT[app].user },
    });
  return { deliver, turns, calls };
}

describe("two registered apps in one channel", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture(WORLD);
  });

  it("A's reply delivered through A and through B is an echo both times: no turn", async () => {
    const g = setup();
    // An engaged thread recorded under A.
    await g.deliver("A0ONE", { user: WORLD.manager, ts: "930.1", text: `<@${BOT.A0ONE.user}> hi` });
    expect(g.turns).toHaveLength(1);
    // A's reply, as Slack delivers it to each app.
    const reply = { user: BOT.A0ONE.user, bot_id: BOT.A0ONE.bot, ts: "930.2", thread_ts: "930.1", text: "ack" };
    await g.deliver("A0ONE", reply);
    await g.deliver("A0TWO", reply);
    expect(g.turns).toHaveLength(1);
  });

  it("A's bot posting in a thread B is engaged in is not a turn for B (the bots never answer each other)", async () => {
    const g = setup();
    await g.deliver("A0TWO", { user: WORLD.manager, ts: "933.1", text: `<@${BOT.A0TWO.user}> hi` });
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0TWO", { user: BOT.A0ONE.user, bot_id: BOT.A0ONE.bot, ts: "933.2", thread_ts: "933.1", text: "from A" });
    expect(g.turns).toHaveLength(1);
  });

  it("a mention of B's bot is answered through B's delivery, not A's, and B's echo is dropped", async () => {
    const g = setup();
    const msg = { user: WORLD.manager, ts: "931.1", text: `<@${BOT.A0TWO.user}> status?` };
    await g.deliver("A0ONE", msg); // A's copy: addressed to another app
    expect(g.turns).toHaveLength(0);
    await g.deliver("A0TWO", msg);
    expect(g.turns).toHaveLength(1);
    expect((await Sessions.findById(g.turns[0]!))!.slack_app_id).toBe("A0TWO");
    // Nothing of this turn went out as A.
    await new Promise((r) => setTimeout(r, 20));
    expect(g.calls.filter((c) => c.endsWith(":A0ONE"))).toEqual([]);
    // B's own reply comes back through B: an echo.
    await g.deliver("A0TWO", { user: BOT.A0TWO.user, bot_id: BOT.A0TWO.bot, ts: "931.2", thread_ts: "931.1", text: "fine" });
    expect(g.turns).toHaveLength(1);
  });

  // R1-F1: the job's runs post as the app the command arrived through.
  it("/cron-add sent through B stores a job recorded under B", async () => {
    const g = setup();
    await db.run("DELETE FROM cron_jobs");
    await g.deliver("A0TWO", { user: WORLD.manager, ts: "934.1", text: `<@${BOT.A0TWO.user}> /cron-add "0 9 * * *" "daily digest"` });
    const jobs = await db.query<{ slack_app_id: string | null }>("SELECT slack_app_id FROM cron_jobs");
    expect(jobs).toEqual([{ slack_app_id: "A0TWO" }]);
    await db.run("DELETE FROM cron_jobs");
  });

  it("a plain reply in a thread recorded under A is continued by A's copy only", async () => {
    const g = setup();
    await g.deliver("A0ONE", { user: WORLD.manager, ts: "932.1", text: `<@${BOT.A0ONE.user}> hi` });
    expect(g.turns).toHaveLength(1);
    const plain = { user: WORLD.manager, ts: "932.2", thread_ts: "932.1", text: "and another thing" };
    await g.deliver("A0TWO", plain); // B's copy arrives first
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0ONE", plain);
    expect(g.turns).toHaveLength(2);
    expect((await Sessions.findById(g.turns[1]!))!.slack_app_id).toBe("A0ONE");
  });
});
