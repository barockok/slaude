import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Sessions from "../../../src/db/sessions";
import * as Posts from "../../../src/db/proactive-posts";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter, DecisionResult } from "../../../src/decision/types";
import { resetBackend, setBackendForTest } from "../../../src/knowledge/backend";
import { fakeBrain } from "../../memory/fake-brain";

/**
 * Replies under a proactive post at the Slack ingress (spec §5 Stitching): a
 * channel reply without a mention gets a turn, the turn carries the post's
 * `<proactive-context>`, and the decision gate is never consulted for that
 * thread. Only threaded replies count: a top-level DM message after a post is
 * an ordinary DM turn. A stop phrase still mutes with no turn.
 */

const TEAM = "T";
const CH = "C0TEAM"; // trusted channel in WORLD
const AGENT = "U0AGENT";
const POSTED = Date.parse("2026-10-27T09:00:00Z");

function makeTransport() {
  const posts: any[] = [];
  const events = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: `${Date.now()}.0` }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({ ok: true, messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    } as any,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await events.get(name)?.(args); };
  return { t, posts, emit };
}

/** A gate that would record every message (chit-chat, not addressed): it must not be asked. */
function recordingAdapter() {
  const asked: string[] = [];
  const no = { choice: "no", confidence: 0.99 };
  const a: DecisionAdapter = {
    name: "fake",
    decide: async (req): Promise<DecisionResult> => {
      asked.push((req.state as any).message);
      return { addressedToAgent: no, isQuestionOrRequest: no, agentCanHelp: no, alreadyAnswered: no } as DecisionResult;
    },
  };
  return { a, asked };
}

function makeGw() {
  const cap = makeTransport();
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const gate = recordingAdapter();
  const gateRunner = makeGateRunner({ mode: "on", adapter: gate.a, tAct: 0.8, timeoutMs: 500, contextMessages: 8, log: () => {} });
  const h = createGateway(agent, cap.t, { gateRunner });
  return { ...cap, agent, sends, h, asked: gate.asked };
}

const msg = (client: any, text: string, ts: string, opts: { user?: string; thread?: string; parent?: string; channel?: string; im?: boolean } = {}) => ({
  event: {
    type: "message", channel: opts.channel ?? CH, channel_type: opts.im ? "im" : "channel",
    user: opts.user ?? WORLD.manager, team: TEAM, ts,
    ...(opts.thread ? { thread_ts: opts.thread } : {}),
    ...(opts.parent ? { parent_user_id: opts.parent } : {}),
    text,
  },
  client,
  context: { teamId: TEAM },
});

let seq = 80_000;
const nextTs = () => `${++seq}.1`;

async function proactivePost(over: { channelId?: string; audience?: Posts.Audience; recipient?: string } = {}) {
  const ts = nextTs();
  const channelId = over.channelId ?? CH;
  await Posts.recordPost({
    agentId: AGENT, audience: over.audience ?? "channel", recipient: over.recipient ?? channelId, topic: "invoice",
    textHash: "h", evidenceHash: "e", channelId, messageTs: ts, teamId: TEAM, postedAt: POSTED,
    text: "An invoice came in from the vendor.",
    context: { source: "mail", itemId: "m-42", summary: "Vendor invoice", ruleSlug: null, level: "inform", evidence: "mail m-42" },
  });
  return ts;
}

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let gw: ReturnType<typeof makeGw> | null = null;
beforeEach(async () => {
  writeSoulFixture(WORLD);
  const brain = fakeBrain();
  setBackendForTest({ ready: () => true, call: (n: string, p: Record<string, unknown>, s: any) => brain.call(n, p, s), adminCall: async () => null } as any);
  for (const t of ["sessions", "seen_events", "pending_gates", "proactive_posts"]) await db.run(`DELETE FROM ${t}`);
  OneOnOne._wipeForTests();
});

afterEach(async () => {
  await gw?.h.stop();
  gw = null;
  resetBackend();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("replies under a proactive post", () => {
  it("a channel reply without a mention under a proactive post gets a turn with proactive-context and skips the gate", async () => {
    const g = (gw = makeGw());
    const root = await proactivePost();
    await g.emit("message", msg(g.t.client, "thanks, which vendor is it", nextTs(), { thread: root, parent: "USLAUDEBOT" }));
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]).toContain("<proactive-context>");
    expect(g.sends[0]).toContain('about "invoice": An invoice came in from the vendor.');
    expect(g.sends[0]).toContain("use proactive_rule.");
    expect(g.sends[0]).not.toContain("recorded for context only");
    expect((await Sessions.findByThread({ team_id: TEAM, channel_id: CH, thread_ts: root, persona_id: "default" }))?.engaged).toBe(1);
    // A later plain reply in the now engaged thread also skips the gate.
    await g.emit("message", msg(g.t.client, "ok cool", nextTs(), { thread: root }));
    expect(g.sends).toHaveLength(2);
    expect(g.sends[1]).not.toContain("recorded for context only");
    expect(g.asked).toEqual([]);
  });

  it("a plain reply in an ordinary engaged thread still consults the gate", async () => {
    const g = (gw = makeGw());
    const root = nextTs();
    await g.emit("message", msg(g.t.client, "<@USLAUDEBOT> hi", root));
    await g.emit("message", msg(g.t.client, "ok cool", nextTs(), { thread: root }));
    expect(g.asked.length).toBeGreaterThan(0);
    expect(g.sends.every((s) => !s.includes("<proactive-context>"))).toBe(true);
  });

  it("a top-level DM message after a post gets no block", async () => {
    const g = (gw = makeGw());
    const root = await proactivePost({ channelId: "D0MANAGER", audience: "manager", recipient: WORLD.manager });
    await g.emit("message", msg(g.t.client, "about that invoice: pay it", nextTs(), { channel: "D0MANAGER", im: true }));
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]).not.toContain("<proactive-context>");
    // A threaded DM reply does carry it.
    await g.emit("message", msg(g.t.client, "pay it", nextTs(), { channel: "D0MANAGER", im: true, thread: root }));
    expect(g.sends).toHaveLength(2);
    expect(g.sends[1]).toContain("<proactive-context>");
  });

  it("stop phrase still mutes with no turn", async () => {
    const g = (gw = makeGw());
    const root = await proactivePost();
    await g.emit("message", msg(g.t.client, "stop", nextTs(), { thread: root }));
    expect(g.sends).toEqual([]);
    expect(g.posts.map((p) => p.text)).toContain("Got it, I'll stop pinging you about invoice.");
    expect(g.asked).toEqual([]);
  });

  it("with two registered apps in the channel, only the posting app's copy takes the thread", async () => {
    const BOT = { A0ONE: "U0BOTA", A0TWO: "U0BOTB" } as const;
    type App = keyof typeof BOT;
    const handlers = new Map<string, (args: any) => Promise<void>>();
    const clientOf = (app: App): any => ({
      auth: { test: async () => ({ user_id: BOT[app], bot_id: `B${app}`, team: TEAM, url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
      conversations: { info: async () => ({}), members: async () => ({ ok: true, members: [WORLD.manager, BOT.A0ONE, BOT.A0TWO] }), replies: async () => ({ ok: true, messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    });
    const clients = { A0ONE: clientOf("A0ONE"), A0TWO: clientOf("A0TWO") };
    const t: Transport = {
      client: clients.A0ONE,
      clientFor: (app: AppRef) => clients[(app.apiAppId ?? "A0ONE") as App],
      apps: async () => (["A0ONE", "A0TWO"] as App[]).map((id) => ({ apiAppId: id, teamId: TEAM, botUserId: BOT[id], client: clients[id] })),
      action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
      event: (name: string, fn: any) => void handlers.set(name, fn),
    };
    const agent = new AgentManager();
    const turns: string[] = [];
    agent.sendMessage = async (id: string) => void turns.push(id);
    const h = createGateway(agent, t);
    gw = { h } as any;
    const deliver = (app: App, event: Record<string, unknown>) =>
      handlers.get("message")!({
        event: { type: "message", channel: CH, channel_type: "channel", team: TEAM, user: WORLD.manager, ...event },
        client: clients[app],
        context: { teamId: TEAM, apiAppId: app, botUserId: BOT[app] },
      });

    // B made the post; A's copy arrives first and must not take the thread.
    const root = await proactivePost();
    const reply = { ts: nextTs(), thread_ts: root, parent_user_id: BOT.A0TWO, text: "which vendor?" };
    await deliver("A0ONE", reply);
    expect(turns).toEqual([]);
    await deliver("A0TWO", reply);
    expect(turns).toHaveLength(1);
    expect((await Sessions.findById(turns[0]!))!.slack_app_id).toBe("A0TWO");

    // No parent_user_id with another app's bot in the channel: neither copy takes it.
    const root2 = await proactivePost();
    const bare = { ts: nextTs(), thread_ts: root2, text: "which vendor?" };
    await deliver("A0ONE", bare);
    await deliver("A0TWO", bare);
    expect(turns).toHaveLength(1);
  });
});
