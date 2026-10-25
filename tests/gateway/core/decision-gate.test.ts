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
import * as Sessions from "../../../src/db/sessions";
import { makeGateRunner, type GateMode, type GateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter, DecisionRequest, DecisionResult } from "../../../src/decision/types";
import type { GateInput } from "../../../src/gateway/gate/types";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { setSoulData, soulData } from "../../../src/soul/extract";
import * as Ignores from "../../../src/db/ignores";
import * as SlackOauthFlows from "../../../src/db/slack-oauth-flows";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { metrics } from "../../../src/metrics";

/**
 * Phase B, task 5: the decision gate at the gateway's Slack ingress. Mentions
 * and engaged plain replies consult the gate; DMs, /1on1-locked threads and
 * the other paths never do. Off and shadow are today's behaviour exactly.
 */

const TEAM = "T";
const CH = "C0TEAM"; // trusted channel in WORLD
const RECORDED = "recorded for context only"; // the suppressed envelope's marker

function makeTransport(replies: (a: any) => Promise<any> = async () => ({ ok: true, messages: [] })) {
  const posts: any[] = [];
  const reacts: any[] = [];
  const events = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: `${Date.now()}.0` }; }, update: async () => ({ ok: true }) },
      reactions: { add: async (a: any) => { reacts.push(a); return { ok: true }; }, remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    } as any,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await events.get(name)?.(args); };
  return { t, posts, reacts, emit };
}

/**
 * A fake adapter that answers from the message text the way a real model
 * would read it: a mention is addressed to the agent only when the text names
 * `<agent>` ("doubt" makes it a mention about the agent instead), "?" is an
 * open, helpful request, anything else chit-chat.
 */
function fakeAdapter() {
  const states: GateInput[] = [];
  const yes = (c = 0.95) => ({ choice: "yes", confidence: c });
  const no = (c = 0.95) => ({ choice: "no", confidence: c });
  const a: DecisionAdapter = {
    name: "fake",
    decide: async (req: DecisionRequest): Promise<DecisionResult> => {
      const s = req.state as GateInput;
      states.push(s);
      const q = s.message.includes("?");
      return {
        addressedToAgent: s.message.includes("<agent>") && !s.message.includes("doubt") ? yes() : no(),
        isQuestionOrRequest: q ? yes() : no(),
        agentCanHelp: q ? yes() : no(),
        alreadyAnswered: no(),
      };
    },
  };
  return { a, states };
}

const runner = (mode: GateMode, adapter: DecisionAdapter | null): GateRunner =>
  makeGateRunner({ mode, adapter, tAct: 0.8, timeoutMs: 500, contextMessages: 8, log: () => {} });

/** Gateway + a stubbed agent recording every dispatched envelope. No runner: the gateway's own default. */
function makeGw(gateRunner?: GateRunner, replies?: (a: any) => Promise<any>, extra: Record<string, unknown> = {}) {
  const cap = makeTransport(replies);
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const h = createGateway(agent, cap.t, { ...(gateRunner ? { gateRunner } : {}), ...extra });
  return { ...cap, agent, sends, h };
}

const msg = (client: any, text: string, ts: string, opts: { user?: string; thread?: string; channel?: string; im?: boolean } = {}) => ({
  event: {
    type: "message", channel: opts.channel ?? CH, channel_type: opts.im ? "im" : "channel",
    user: opts.user ?? WORLD.manager, team: TEAM, ts,
    ...(opts.thread ? { thread_ts: opts.thread } : {}),
    text,
  },
  client,
  context: { teamId: TEAM },
});

/** Real Slack order for a bot mention: app_mention, then the message copy. */
async function mention(g: ReturnType<typeof makeGw>, ts: string, text: string, thread?: string) {
  const args = msg(g.t.client, text, ts, { thread });
  await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
  await g.emit("message", args);
}

let seq = 70_000;
const nextTs = () => `${++seq}.1`;

const recorded = (s: string) => s.includes(RECORDED);
const row = (thread: string) => Sessions.findByThread({ team_id: TEAM, channel_id: CH, thread_ts: thread, persona_id: "default" });

/** Today's engagement scenario: mention, plain reply, colleague disengage, plain reply. */
async function scenario(g: ReturnType<typeof makeGw>) {
  const thread = nextTs();
  await mention(g, thread, "<@USLAUDEBOT> hi there");
  await g.emit("message", msg(g.t.client, "thanks, nice", nextTs(), { thread }));
  await g.emit("message", msg(g.t.client, "<@U0APP> your turn", nextTs(), { thread }));
  await g.emit("message", msg(g.t.client, "ok cool", nextTs(), { thread }));
  // A fresh top-level mention that the adapter would doubt.
  await mention(g, nextTs(), "<@USLAUDEBOT> doubt the bot is useful");
  return g.sends.map((s): string => (recorded(s) ? "recorded" : "run"));
}

beforeEach(async () => {
  writeSoulFixture(WORLD);
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM pending_gates");
  await db.run("DELETE FROM ignores");
  await db.run("DELETE FROM slack_oauth_flows");
  OneOnOne._wipeForTests();
});

afterEach(() => {
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("decision gate at the Slack ingress", () => {
  const TODAY = ["run", "run", "recorded", "recorded", "run"];

  it("off: every existing engagement scenario is unchanged", async () => {
    expect(await scenario(makeGw())).toEqual(TODAY);
    const f = fakeAdapter();
    const g = makeGw(runner("off", f.a));
    expect(await scenario(g)).toEqual(TODAY);
    expect(f.states.length).toBe(0);
    expect(g.reacts.filter((r) => r.name === "thinking_face")).toEqual([]);
  });

  it("on with no adapter equals off", async () => {
    const g = makeGw(runner("on", null));
    expect(await scenario(g)).toEqual(TODAY);
    expect(g.reacts.filter((r) => r.name === "thinking_face")).toEqual([]);
  });

  it("doubt on a mention reacts thinking_face and does not engage", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a));
    const thread = nextTs();
    await mention(g, thread, "<@USLAUDEBOT> can you help?");
    expect(g.sends.length).toBe(1);
    // A colleague takes over: the thread is disengaged.
    await g.emit("message", msg(g.t.client, "<@U0APP> your turn", nextTs(), { thread }));
    expect((await row(thread))?.engaged).toBe(0);

    const ts = nextTs();
    await mention(g, ts, "<@USLAUDEBOT> doubt it knows", thread);
    expect(g.reacts.some((r) => r.name === "thinking_face" && r.timestamp === ts && r.channel === CH)).toBe(true);
    // Recorded into the existing session, suppressed; the thread stays disengaged.
    expect(recorded(g.sends.at(-1)!)).toBe(true);
    expect((await row(thread))?.engaged).toBe(0);
    // Both copies of the mention share one decision.
    expect(f.states.filter((s) => s.message.includes("doubt")).length).toBe(1);
  });

  it("doubt on a fresh thread creates no session", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a));
    const ts = nextTs();
    await mention(g, ts, "<@USLAUDEBOT> doubt anyone reads this");
    expect(g.reacts.some((r) => r.name === "thinking_face" && r.timestamp === ts)).toBe(true);
    expect(g.sends).toEqual([]);
    expect(await row(ts)).toBeNull();
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
    expect(Number(n?.n)).toBe(0);
  });

  it("engaged chit-chat is recorded, a helpful question runs", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a));
    const thread = nextTs();
    await mention(g, thread, "<@USLAUDEBOT> hi?");
    await g.emit("message", msg(g.t.client, "thanks, nice", nextTs(), { thread }));
    await g.emit("message", msg(g.t.client, "how do I deploy?", nextTs(), { thread }));
    expect(g.sends.map((s) => (recorded(s) ? "recorded" : "run"))).toEqual(["run", "recorded", "run"]);
    // Recording does not disengage the thread.
    expect((await row(thread))?.engaged).toBe(1);
    const plain = f.states.filter((s) => !s.mentionsAgent);
    expect(plain.every((s) => s.engaged && s.channelTrust === "trusted")).toBe(true);
  });

  it("the thread context is the tail up to the event, with roles and normalized text", async () => {
    const thread = nextTs();
    const calls: any[] = [];
    // Two pages: the first holds the thread's head, the second its tail.
    const all = Array.from({ length: 12 }, (_, i) => ({
      ts: String(Number(thread) + i),
      user: i % 2 ? "USLAUDEBOT" : "U0X",
      text: i === 11 ? "ask <@USLAUDEBOT>" : `m${i}`,
    }));
    const replies = async (a: any) => {
      calls.push(a);
      return a.cursor
        ? { ok: true, messages: all.slice(6) }
        : { ok: true, messages: all.slice(0, 6), response_metadata: { next_cursor: "c2" } };
    };
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a), replies);
    const ts = String(Number(thread) + 20);
    await mention(g, ts, "<@USLAUDEBOT> what now?", thread);
    expect(calls[0]).toMatchObject({ channel: CH, ts: thread, latest: ts, inclusive: true, limit: 200 });
    const s = f.states[0]!;
    expect(s.recent.length).toBe(8);
    expect(s.recent.at(-1)).toEqual({ role: "agent", text: "ask <agent>" });
    expect(s.recent[0]!.text).toBe("m4");
    expect(s.message).toBe("<agent> what now?");
  });

  it("a named persona: doubt is recorded as the persona, engaged chit-chat too", async () => {
    const ana = { name: "ana", slackUserId: "U0ANA" } as any;
    const reg: PersonaRegistry = {
      lookupByUserId: (id) => (id === "U0ANA" ? ana : null),
      lookupByName: (n) => (n === "ana" ? ana : null),
      list: () => [ana],
      isMultiPersonaMode: () => true,
      isManaged: () => false,
      tombstonedPersonaFor: () => null,
    };
    setPersonaRegistry(reg);
    try {
      const f = fakeAdapter();
      const g = makeGw(runner("on", f.a));
      const thread = nextTs();
      await g.emit("message", msg(g.t.client, "<@U0ANA> can you look?", thread));
      expect(g.sends.length).toBe(1);
      const anaRow = () => Sessions.findByThread({ team_id: TEAM, channel_id: CH, thread_ts: thread, persona_id: "ana" });
      expect((await anaRow())?.engaged).toBe(1);
      await g.emit("message", msg(g.t.client, "nice one", nextTs(), { thread }));
      const ts = nextTs();
      await g.emit("message", msg(g.t.client, "<@U0ANA> doubt she knows", ts, { thread }));
      expect(g.sends.map((s) => (recorded(s) ? "recorded" : "run"))).toEqual(["run", "recorded", "recorded"]);
      expect(g.reacts.some((r) => r.name === "thinking_face" && r.timestamp === ts)).toBe(true);
      // Every turn ran as ana: no default-persona session was created.
      expect(await row(thread)).toBeNull();
    } finally {
      __resetPersonaRegistry();
    }
  });

  it("a long thread: the context is its tail before the event, read in at most 5 pages", async () => {
    const thread = nextTs();
    const base = Number(thread);
    // 600 replies; the event is the 596th. A fake honouring latest, limit and cursor like Slack.
    const all = Array.from({ length: 600 }, (_, i) => ({ ts: String(base + i), user: "U0X", text: `m${i}` }));
    const ts = all[595]!.ts;
    const calls: any[] = [];
    const replies = async (a: any) => {
      calls.push(a);
      const upTo = all.filter((m) => Number(m.ts) <= Number(a.latest));
      const from = a.cursor ? Number(a.cursor) : 0;
      const page = upTo.slice(from, from + a.limit);
      const next = from + a.limit < upTo.length ? String(from + a.limit) : "";
      return { ok: true, messages: page, response_metadata: { next_cursor: next } };
    };
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a), replies);
    await g.emit("message", msg(g.t.client, "<@USLAUDEBOT> and now?", ts, { thread }));
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(f.states[0]!.recent.map((r) => r.text)).toEqual(Array.from({ length: 8 }, (_, i) => `m${587 + i}`));
  });

  it("an off runner is never consulted", async () => {
    let calls = 0;
    const off: GateRunner = { mode: "off", contextMessages: 8, gate: async () => { calls++; return undefined; } };
    expect(await scenario(makeGw(off))).toEqual(TODAY);
    expect(calls).toBe(0);
  });

  it("no thinking_face on a mention the other copy already handled", async () => {
    // A recomputed decision: the first copy runs, the second is doubted.
    let n = 0;
    const flip: GateRunner = { mode: "on", contextMessages: 8, gate: async () => (n++ === 0 ? "run" : "record_doubt") };
    const g = makeGw(flip);
    const ts = nextTs();
    await mention(g, ts, "<@USLAUDEBOT> help me");
    expect(n).toBe(2);
    expect(g.sends.map((s) => (recorded(s) ? "recorded" : "run"))).toEqual(["run"]);
    expect(g.reacts.filter((r) => r.name === "thinking_face")).toEqual([]);
  });

  it("a /1on1-locked thread never calls the gate", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a));
    const thread = nextTs();
    await OneOnOne.lock({ channelId: CH, threadTs: thread, lockedUser: WORLD.manager, createdBy: WORLD.manager });
    await mention(g, thread, "<@USLAUDEBOT> doubt this");
    await g.emit("message", msg(g.t.client, "thanks", nextTs(), { thread }));
    expect(f.states.length).toBe(0);
    expect(g.sends.filter((s) => !recorded(s)).length).toBe(2);
    expect(g.reacts.filter((r) => r.name === "thinking_face")).toEqual([]);
  });

  it("DMs never call the gate", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("on", f.a));
    await g.emit("message", msg(g.t.client, "thanks", nextTs(), { channel: "D_MGR", im: true }));
    expect(f.states.length).toBe(0);
    expect(g.sends.length).toBe(1);
    expect(recorded(g.sends[0]!)).toBe(false);
  });

  it("shadow behaves exactly like off", async () => {
    const f = fakeAdapter();
    const g = makeGw(runner("shadow", f.a));
    expect(await scenario(g)).toEqual(TODAY);
    expect(g.reacts.filter((r) => r.name === "thinking_face")).toEqual([]);
    // The detached decisions did run.
    await new Promise((r) => setTimeout(r, 20));
    expect(f.states.length).toBeGreaterThan(0);
  });

  it("a gate that throws keeps today's path", async () => {
    const boom: GateRunner = { mode: "on", contextMessages: 8, gate: async () => { throw new Error("boom"); } };
    expect(await scenario(makeGw(boom))).toEqual(TODAY);
  });
});

/** A registry with one named persona, `ana`. `outClient` set: ana posts with her own user token. */
function anaRegistry(outClient: any = null): PersonaRegistry {
  const ana = { name: "ana", slackUserId: "U0ANA", outClient } as any;
  return {
    lookupByUserId: (id) => (id === "U0ANA" ? ana : null),
    lookupByName: (n) => (n === "ana" ? ana : null),
    list: () => [ana],
    isMultiPersonaMode: () => true,
    isManaged: () => false,
    tombstonedPersonaFor: () => null,
  };
}

/** An adapter that answers "no" to everything and records what it saw. */
function alwaysNo() {
  const seen: string[] = [];
  const no = { choice: "no", confidence: 0.95 };
  const a: DecisionAdapter = {
    name: "no",
    decide: async (req) => {
      seen.push((req.state as GateInput).message);
      return { addressedToAgent: no, isQuestionOrRequest: no, agentCanHelp: no, alreadyAnswered: no };
    },
  };
  return { a, seen };
}

const doubts = (g: ReturnType<typeof makeGw>) => g.reacts.filter((r) => r.name === "thinking_face");

describe("decision gate: the agent's own identities", () => {
  it("a persona mention is framed as addressed to <agent>, and runs", async () => {
    setPersonaRegistry(anaRegistry());
    try {
      const f = fakeAdapter();
      const g = makeGw(runner("on", f.a));
      const thread = nextTs();
      await g.emit("message", msg(g.t.client, "<@U0ANA> can you look? cc <@U0X>", thread));
      expect(f.states[0]!.message).toBe("<agent> can you look? cc <user>");
      expect(g.sends.length).toBe(1);
      expect(recorded(g.sends[0]!)).toBe(false);
      expect(doubts(g)).toEqual([]);
    } finally {
      __resetPersonaRegistry();
    }
  });

  it("an engaged persona thread frames the persona as <agent>", async () => {
    setPersonaRegistry(anaRegistry());
    try {
      const f = fakeAdapter();
      const g = makeGw(runner("on", f.a));
      const thread = nextTs();
      await g.emit("message", msg(g.t.client, "<@U0ANA> hi?", thread));
      await g.emit("message", msg(g.t.client, "and <@U0ANA> what about tests?", nextTs(), { thread }));
      expect(f.states.at(-1)!.message).toBe("and <agent> what about tests?");
    } finally {
      __resetPersonaRegistry();
    }
  });

  it("posts by any own identity are role agent: bot user, bot id, persona user token, post-as-user", async () => {
    const outClient = {
      auth: { test: async () => ({ user_id: "U0SELFUSER" }) },
      chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    };
    setPersonaRegistry(anaRegistry(outClient));
    try {
      const thread = nextTs();
      const base = Number(thread);
      const history = [
        { ts: String(base), user: "U0X", text: "question" },
        { ts: String(base + 1), user: "U0ANA", text: "persona answer" },
        { ts: String(base + 2), user: "U0SELFUSER", text: "post-as-user answer" },
        { ts: String(base + 3), user: "USLAUDEBOT", text: "bot answer" },
        { ts: String(base + 4), bot_id: "B_SLAUDE", text: "bot id answer" },
        { ts: String(base + 5), user: "U0Y", text: "colleague" },
      ];
      const f = fakeAdapter();
      const g = makeGw(runner("on", f.a), async () => ({ ok: true, messages: history }), { outClient });
      await g.emit("message", msg(g.t.client, "<@USLAUDEBOT> so?", String(base + 10), { thread }));
      expect(f.states[0]!.recent.map((r) => r.role)).toEqual(["user", "agent", "agent", "agent", "agent", "user"]);
    } finally {
      __resetPersonaRegistry();
    }
  });
});

describe("decision gate: messages the ingress drops never reach the adapter", () => {
  it("a blocked user", async () => {
    setSoulData({ ...soulData(), blockedUsers: ["U0BLOCKED"] });
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    const args = msg(g.t.client, "<@USLAUDEBOT> hello", nextTs(), { user: "U0BLOCKED" });
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
    await g.emit("message", args);
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
    expect(g.sends).toEqual([]);
  });

  it("a non-manager in an unlisted channel", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    const args = msg(g.t.client, "<@USLAUDEBOT> private stuff here", nextTs(), { channel: "C0SECRET", user: "U0RANDOM" });
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
    await g.emit("message", args);
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
    expect(g.sends).toEqual([]);
  });

  it("an ignored thread, mention and engaged reply", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("off", null));
    const thread = nextTs();
    await mention(g, thread, "<@USLAUDEBOT> hi");
    expect(g.sends.length).toBe(1);
    await Ignores.create({ targetType: "thread", channelId: CH, threadTs: thread, createdBy: WORLD.manager });
    const g2 = makeGw(runner("on", n.a));
    await mention(g2, nextTs(), "<@USLAUDEBOT> again", thread);
    await g2.emit("message", msg(g2.t.client, "plain reply", nextTs(), { thread }));
    expect(n.seen).toEqual([]);
    expect(doubts(g2)).toEqual([]);
    expect(g2.sends).toEqual([]);
  });

  it("an ignored user", async () => {
    await Ignores.create({ targetType: "user", userId: "U0APP", createdBy: WORLD.manager });
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    await mention(g, nextTs(), "<@USLAUDEBOT> hello");
    const args = msg(g.t.client, "<@USLAUDEBOT> hello", nextTs(), { user: "U0APP" });
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
    await g.emit("message", args);
    // Only the manager's mention reached the adapter.
    expect(n.seen).toEqual(["<agent> hello"]);
  });

  it("a self echo delivered as app_mention", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    const args = msg(g.t.client, "<@USLAUDEBOT> note to self", nextTs(), { user: "USLAUDEBOT" });
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention", bot_id: "B_SLAUDE" } });
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
  });

  it("a bare mention with no text", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    await mention(g, nextTs(), "<@USLAUDEBOT>");
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
  });
});

describe("decision gate: text slash commands bypass it", () => {
  it("a /help mention in a fresh thread is answered, never gated", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    await mention(g, nextTs(), "<@USLAUDEBOT> /help");
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
    expect(g.posts.length).toBe(1);
  });

  it("/1on1 and /abort in an engaged thread never wait for the gate", async () => {
    const n = alwaysNo();
    const g = makeGw(runner("on", n.a));
    const thread = nextTs();
    await mention(g, thread, "<@USLAUDEBOT> /help");
    await g.emit("message", msg(g.t.client, "/abort", nextTs(), { thread }));
    await g.emit("message", msg(g.t.client, "<@USLAUDEBOT> /1on1", nextTs(), { thread }));
    expect(n.seen).toEqual([]);
    expect(doubts(g)).toEqual([]);
    expect(await OneOnOne.find(CH, thread)).not.toBeNull();
  });

  it("a persona's slash command bypasses it", async () => {
    setPersonaRegistry(anaRegistry());
    try {
      const n = alwaysNo();
      const g = makeGw(runner("on", n.a));
      await g.emit("message", msg(g.t.client, "<@U0ANA> /help", nextTs()));
      expect(n.seen).toEqual([]);
      expect(doubts(g)).toEqual([]);
      expect(g.posts.length).toBe(1);
    } finally {
      __resetPersonaRegistry();
    }
  });

  it("a pasted OAuth callback with a parked connect flow bypasses it", async () => {
    const priorKey = process.env.SLAUDE_MASTER_KEY;
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    try {
      const n = alwaysNo();
      const g = makeGw(runner("on", n.a));
      const thread = nextTs();
      await mention(g, thread, "<@USLAUDEBOT> /help");
      await SlackOauthFlows.putFlow(`${CH}:${thread}:${WORLD.manager}`, {
        state: "st-1",
        parts: {
          tokenEndpoint: "https://auth.example.com/token", redirectUri: "https://slaude.example.com/oauth/cb",
          clientId: "client-1", clientSecret: "cs-1", verifier: "v-1", resource: "https://mcp.example.com/mcp",
        },
        serverName: "workbench", cfg: { type: "http", url: "https://mcp.example.com/mcp" },
        sessionId: "s-1", channelId: CH, threadTs: thread, userId: WORLD.manager, scope: "global", authMsgRef: "1.5",
      } as any);
      await g.emit("message", msg(g.t.client, "<https://slaude.example.com/oauth/cb?code=abc&state=st-1>", nextTs(), { thread }));
      expect(n.seen).toEqual([]);
      expect(doubts(g)).toEqual([]);
    } finally {
      if (priorKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
      else process.env.SLAUDE_MASTER_KEY = priorKey;
      __resetMasterKeyCache();
    }
  });
});

describe("handleMessage early drops through the shared predicate", () => {
  /** slaude_slack_drops_total for one reason, read from the rendered registry. */
  const drops = (reason: string): number => {
    const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_slack_drops_total{") && l.includes(`reason="${reason}"`));
    return line ? Number(line.split(" ").at(-1)) : 0;
  };
  /** Run fn with console.log captured; returns the [slack-rx] drop lines. */
  const dropLines = async (fn: () => Promise<void>): Promise<string[]> => {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...a: any[]) => { const l = a.map(String).join(" "); if (l.startsWith("[slack-rx] drop")) lines.push(l); };
    try { await fn(); } finally { console.log = orig; }
    return lines;
  };
  const appMention = (g: ReturnType<typeof makeGw>, args: any, extra: Record<string, unknown> = {}) =>
    g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention", ...extra } });

  // The expected lines are the literal strings handleMessage printed before the
  // filters moved into preTurnDropReason. Off mode: handleMessage alone.
  it("each filter logs today's line and increments today's reason", async () => {
    setSoulData({ ...soulData(), blockedUsers: ["U0BLOCKED"] });
    const g = makeGw(runner("off", null));
    const cases: { reason: string; run: () => Promise<void>; line: (ts: string) => string; ts: string }[] = [];

    const tBlocked = nextTs();
    cases.push({ reason: "blocked_user", ts: tBlocked, line: () => `[slack-rx] drop ch=${CH} user=U0BLOCKED — blocked user`,
      run: () => appMention(g, msg(g.t.client, "<@USLAUDEBOT> hi", tBlocked, { user: "U0BLOCKED" })) });

    const tUnlisted = nextTs();
    cases.push({ reason: "whitelist", ts: tUnlisted,
      line: () => `[slack-rx] drop ch=C0SECRET user=U0RANDOM — non-whitelist/DM accepts manager/backup only`,
      run: () => appMention(g, msg(g.t.client, "<@USLAUDEBOT> hi", tUnlisted, { channel: "C0SECRET", user: "U0RANDOM" })) });

    const thread = nextTs();
    await Ignores.create({ targetType: "thread", channelId: CH, threadTs: thread, createdBy: WORLD.manager });
    const tIgnored = nextTs();
    cases.push({ reason: "ignored", ts: tIgnored, line: () => `[slack-rx] drop ch=${CH} user=${WORLD.manager} thread=${thread} — ignored`,
      run: () => appMention(g, msg(g.t.client, "<@USLAUDEBOT> hi", tIgnored, { thread })) });

    const tEcho = nextTs();
    cases.push({ reason: "self_bot", ts: tEcho, line: (ts) => `[slack-rx] drop ch=${CH} ts=${ts} — self bot echo`,
      run: () => appMention(g, msg(g.t.client, "<@USLAUDEBOT> note", tEcho, { user: "USLAUDEBOT" }), { bot_id: "B_SLAUDE" }) });

    for (const c of cases) {
      const before = drops(c.reason);
      const lines = await dropLines(c.run);
      expect(lines).toEqual([c.line(c.ts)]);
      expect(drops(c.reason) - before).toBe(1);
    }

    // Dedup still sits between the self-echo and ignore checks: a redelivered
    // mention logs today's dedup line once.
    const tDup = nextTs();
    const dup = msg(g.t.client, "<@USLAUDEBOT> hi", tDup);
    await appMention(g, dup);
    const before = drops("dedup");
    expect(await dropLines(() => appMention(g, dup))).toEqual([`[slack-rx] drop ch=${CH} ts=${tDup} — dedup (already seen)`]);
    expect(drops("dedup") - before).toBe(1);
    expect(g.sends.length).toBe(1);
  });
});
