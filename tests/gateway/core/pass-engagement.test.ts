import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";

/**
 * A mention that the agent answers with `pass` (and nothing user-visible)
 * must not leave the thread engaged when it was not engaged before: a passing
 * mention ("@bot was great at that yesterday") is not an invitation to answer
 * every later plain message.
 */

const TEAM = "T";
const CH = "C0TEAM"; // trusted channel in WORLD
const PASS = "mcp__slaude_surface__pass";
const REPLY = "mcp__slaude_surface__reply";

function makeTransport() {
  const events = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await events.get(name)?.(args); };
  return { t, emit };
}

/** Gateway + a stubbed agent: each non-suppressed turn emits the planned tool
 *  calls, then `done`. */
function makeGw() {
  const cap = makeTransport();
  const agent = new AgentManager();
  const sends: string[] = [];
  let plan: string[] = [];
  agent.sendMessage = async (id: string, txt: string) => {
    sends.push(txt);
    if (txt.includes("do NOT reply")) return;
    for (const tool of plan) agent.emit("event", { type: "toolCall", sessionId: id, tool, input: {} });
    agent.emit("event", { type: "done", sessionId: id });
  };
  const h = createGateway(agent, cap.t, {});
  return { ...cap, agent, sends, h, setPlan: (p: string[]) => { plan = p; } };
}

const msg = (client: any, text: string, ts: string, opts: { user?: string; thread?: string } = {}) => ({
  event: {
    type: "message", channel: CH, channel_type: "channel",
    user: opts.user ?? WORLD.manager, team: TEAM, ts,
    ...(opts.thread ? { thread_ts: opts.thread } : {}),
    text,
  },
  client,
  context: { teamId: TEAM },
});

/** Engage the way real Slack does: a bot mention fires app_mention first. */
async function mention(g: ReturnType<typeof makeGw>, ts: string, text: string, thread?: string) {
  const args = msg(g.t.client, text, ts, { thread });
  await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
  await g.emit("message", args);
  await settle();
}

/** The done handler runs detached; let its writes land. */
const settle = () => new Promise((r) => setTimeout(r, 30));

let seq = 70_000;
const nextTs = () => `${++seq}.1`;

beforeEach(async () => {
  writeSoulFixture(WORLD);
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM pending_gates");
  OneOnOne._wipeForTests();
});

afterEach(() => {
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("a mention that ends in pass", () => {
  it("first mention + pass leaves thread disengaged", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([PASS]);
    await mention(g, thread, "<@USLAUDEBOT> was great at that yesterday");
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    expect(g.sends.length).toBe(2);
    expect(g.sends.at(-1)).toContain("do NOT reply"); // recorded-suppressed
  });

  it("mention + reply keeps thread engaged", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([REPLY]);
    await mention(g, thread, "<@USLAUDEBOT> can you check this?");
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.length).toBe(2);
    expect(g.sends.at(-1)).not.toContain("do NOT reply");
  });

  it("pass then reply keeps engagement", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([PASS, REPLY]);
    await mention(g, thread, "<@USLAUDEBOT> hmm, maybe?");
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.length).toBe(2);
    expect(g.sends.at(-1)).not.toContain("do NOT reply");
  });

  it("pass in an already-engaged thread keeps it engaged", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([REPLY]);
    await mention(g, thread, "<@USLAUDEBOT> can you check this?");
    g.setPlan([PASS]);
    await mention(g, nextTs(), "<@USLAUDEBOT> nice one", thread);
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.length).toBe(3);
    expect(g.sends.at(-1)).not.toContain("do NOT reply");
  });
});
