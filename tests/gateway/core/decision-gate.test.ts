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
 * A fake adapter that answers from the message text: "doubt" is a mention
 * about the agent, "?" is an open, helpful request, anything else chit-chat.
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
        addressedToAgent: s.message.includes("doubt") ? no() : yes(),
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
function makeGw(gateRunner?: GateRunner, replies?: (a: any) => Promise<any>) {
  const cap = makeTransport(replies);
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const h = createGateway(agent, cap.t, gateRunner ? { gateRunner } : {});
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
    expect(calls[0]).toMatchObject({ channel: CH, ts: thread, latest: ts, inclusive: true });
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
