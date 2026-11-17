import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import { MUST_REPLY_INSTRUCTION } from "../../../src/agent/must-reply";
import type { Transport } from "../../../src/gateway/core/transport";
import type { Surface } from "../../../src/gateway/core/surface";
import { makeSlackSurfaceFactory } from "../../../src/gateway/slack/surface";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo, setSoulData, soulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Sessions from "../../../src/db/sessions";
import * as Grants from "../../../src/db/agent-grants";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter, DecisionRequest } from "../../../src/decision/types";
import { __setEngageBreakerForTests, __setEngageStateForTests, circuitBreaker, memoryEngageState, type CircuitBreaker } from "../../../src/gateway/engage/budget";
import { __setDebounceForTests, shadowIdle } from "../../../src/gateway/engage/shadow";
import { __setUsersCacheForTests, makeUsersCache } from "../../../src/gateway/engage/users";
import { __setLastSpeakerStoreForTests, lastSpeakers } from "../../../src/gateway/engage/last-speaker";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import type { Persona } from "../../../src/persona/types";
import { metrics } from "../../../src/metrics";

/**
 * Implicit engagement, phase 2, through the real handler: with a channel's mode on, a run decision makes
 * the agent take part as if it had been mentioned, born with weaker engagement and told it may pass. In
 * shadow, at level mention, or under the kill switch nothing about what the agent does changes.
 */
const TEAM = "T";
const CH = "C0TEAM";
const PASS = "mcp__slaude_surface__pass";
const REPLY = "mcp__slaude_surface__reply";
const IMPLICIT_NOTE = "was not an @mention of you";

type Msg = Record<string, unknown>;
type Plan = string[];

function makeGw(adapter: DecisionAdapter | null, o: { channel?: string } = {}) {
  const events = new Map<string, (args: any) => Promise<void>>();
  const slack: string[] = [];
  const posts: any[] = [];
  const surfaces: Surface[] = [];
  const state: { thread: Msg[]; history: Msg[]; after: Msg[] } = { thread: [], history: [], after: [] };
  const log = (name: string) => slack.push(name);
  const client: any = {
    auth: { test: async () => ({ user_id: "USLAUDEBOT", user: "quill", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async (a: any) => (log("chat.postMessage"), posts.push(a), { ok: true, ts: `${Date.now()}.${posts.length}` }), update: async () => (log("chat.update"), { ok: true }), postEphemeral: async () => (log("chat.postEphemeral"), { ok: true }) },
    reactions: { add: async () => (log("reactions.add"), { ok: true }), remove: async () => (log("reactions.remove"), { ok: true }) },
    assistant: { threads: { setStatus: async () => (log("assistant.setStatus"), { ok: true }) } },
    conversations: {
      info: async () => (log("conversations.info"), {}), members: async () => (log("conversations.members"), {}),
      replies: async () => (log("conversations.replies"), { ok: true, messages: state.thread, response_metadata: { next_cursor: "" } }),
      history: async (a: any) => (log("conversations.history"), a.oldest !== undefined ? { ok: true, messages: state.after } : { ok: true, messages: [...state.history].reverse() }),
    },
    users: { info: async () => (log("users.info"), { user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: (n: string, fn: any) => void events.set(n, fn) };
  const agent = new AgentManager();
  const sends: { id: string; text: string }[] = [];
  let plan: Plan = [];
  let guard: ((id: string) => string | null) | undefined;
  const setStopGuard = agent.setStopGuard.bind(agent);
  agent.setStopGuard = ((g: any) => { guard = g; setStopGuard(g); }) as any;
  agent.sendMessage = async (id: string, text: string) => {
    sends.push({ id, text });
    if (/do NOT reply/i.test(text)) return;
    for (const tool of plan) agent.emit("event", { type: "toolCall", sessionId: id, tool, input: {} });
    agent.emit("event", { type: "done", sessionId: id });
  };
  const gateRunner = makeGateRunner({ mode: "off", adapter, tAct: 0.8, timeoutMs: 400, contextMessages: 8, log: () => {} });
  const real = makeSlackSurfaceFactory(client);
  const h = createGateway(agent, t, {
    gateRunner,
    lookupClientFactory: () => client,
    surfaceFactory: (b) => {
      const s = real(b);
      surfaces.push(s);
      return s;
    },
  });
  return {
    client, emit: async (n: string, a: any) => { await events.get(n)?.(a); }, sends, h, slack, posts, surfaces, state,
    setPlan: (p: Plan) => { plan = p; },
    guard: (id: string) => guard?.(id) ?? null,
    channel: o.channel ?? CH,
  };
}
type Gw = ReturnType<typeof makeGw>;

const m = (ts: string, user: string, text: string, extra: Msg = {}) => ({ ts, user, text, ...extra });
const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
let seq = 0;
const nextTs = () => nowTs(++seq);
const deliver = (g: Gw, text: string, ts: string, thread?: string, user: string = WORLD.manager, channel?: string) =>
  g.emit("message", { event: { type: "message", channel: channel ?? g.channel, channel_type: "channel", user, team: TEAM, ts, ...(thread ? { thread_ts: thread } : {}), text }, client: g.client, context: { teamId: TEAM } });
const settle = async () => { await Bun.sleep(40); await shadowIdle(); await Bun.sleep(20); };

let asked: DecisionRequest[] = [];
const answering = (choice: "yes" | "no"): DecisionAdapter => ({
  name: "scripted-test",
  decide: async (req) => (asked.push(req), Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "alreadyAnswered" ? "no" : choice, confidence: 0.95 }]))),
});
const yes = answering("yes");
const no = answering("no");
const throws: DecisionAdapter = { name: "scripted-throws", decide: async () => { throw new Error("adapter down"); } };
const hangs: DecisionAdapter = { name: "scripted-hangs", decide: () => new Promise(() => {}) };

const actCount = (outcome: string, tier?: number): number =>
  metrics.render().split("\n")
    .filter((l) => l.startsWith("slaude_engage_act_total{") && l.includes(`outcome="${outcome}"`) && (tier === undefined || l.includes(`tier="${tier}"`)))
    .reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);

const CLEAN = ["sessions", "seen_events", "pending_gates", "ignores", "agent_grants"];
const ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLAUDE_SLACK_MODE", "SLAUDE_SLACK_API_URL", "SLAUDE_ENGAGE_FORCE_SHADOW", "SLAUDE_ENGAGE_ACT_PER_HOUR"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEngage = (level: "mention" | "addressed" | "contribute", mode: "shadow" | "on", channel = CH) =>
  setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel, level, mode }] }));
let gw: Gw | null = null;
let beforeActed = 0;
beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  asked = [];
  writeSoulFixture(WORLD);
  setEngage("addressed", "on");
  __setEngageStateForTests(null);
  __setEngageBreakerForTests(null);
  __setLastSpeakerStoreForTests(null);
  for (const t of CLEAN) await db.run(`DELETE FROM ${t}`);
  await OneOnOne._wipeForTests();
  beforeActed = actCount("acted");
  // The workspace's names are known (nobody shares the agent's), so a name and a comma is a tier 1 run.
  const users = makeUsersCache();
  users.ensure(TEAM, async () => ({ names: new Set<string>(), complete: true }));
  __setUsersCacheForTests(users);
  await Bun.sleep(5);
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await gw?.h.stop();
  gw = null;
  __setEngageStateForTests(null);
  __setEngageBreakerForTests(null);
  __setLastSpeakerStoreForTests(null);
  __setProactiveSoulSource(null);
  __resetPersonaRegistry();
  __setUsersCacheForTests(null);
  __setDebounceForTests(null);
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

const NAMED = "quill, can you look at the deploy?";

describe("phase 2: acting at the final drop", () => {
  it("tier 1 (name and comma) acts at once: a turn runs with the implicit note, in a session, replying under the message", async () => {
    const g = (gw = makeGw(null));
    const ts = nextTs();
    await deliver(g, NAMED, ts);
    await settle();
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain(IMPLICIT_NOTE);
    expect(g.sends[0]!.text).toContain(`thread_ts="${ts}"`);
    expect(g.sends[0]!.text).not.toMatch(/classifier|adapter|decision|engage/i);
    expect(await Sessions.findById(g.sends[0]!.id)).toBeTruthy();
    // The reply goes in the thread of the message for a classic agent.
    await g.surfaces.at(-1)!.reply({ text: "on it" });
    expect(g.posts.at(-1)!.thread_ts).toBe(ts);
    expect(actCount("acted", 1) - beforeActed).toBe(1);
  });

  it("tier 2 (the person the agent answered, request shape) acts, with the thread head seeded on the first turn", async () => {
    const g = (gw = makeGw(null));
    const root = nowTs(-100);
    g.state.thread = [m(root, WORLD.manager, "why is staging red"), m(nowTs(-60), "U0BOT0001", "it is the cache", { bot_id: "B_SLAUDE" })];
    await lastSpeakers().put({ channel: CH, thread: root, persona: "default" }, { ts: nowTs(-30), persona: "default", app: "", repliedToUser: WORLD.manager });
    await deliver(g, "can you also check production?", nextTs(), root);
    await settle();
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain(IMPLICIT_NOTE);
    expect(g.sends[0]!.text).toContain("<thread-head>");
    expect(g.sends[0]!.text).toContain("why is staging red");
    expect(actCount("acted", 2)).toBeGreaterThan(0);
  });

  it("tier 3: a confident classifier run acts; its call was awaited and logged as a decision", async () => {
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    g.state.thread = [m(root, WORLD.manager, "the deploy is stuck again")];
    await deliver(g, "I wonder what quill thinks", nextTs(), root);
    await settle();
    expect(asked).toHaveLength(1);
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain(IMPLICIT_NOTE);
    expect(g.sends[0]!.text).toContain("<thread-head>");
  });

  it("tier 3: a classifier pass drops (nothing runs, nothing is created)", async () => {
    const g = (gw = makeGw(no));
    const before = actCount("classifier_pass");
    await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100));
    await settle();
    expect(asked).toHaveLength(1);
    expect(g.sends).toEqual([]);
    expect(g.slack.filter((c) => c === "chat.postMessage" || c === "reactions.add")).toEqual([]);
    expect(actCount("classifier_pass") - before).toBe(1);
  });

  describe("tier 3 fails closed", () => {
    const cases: Array<[string, () => DecisionAdapter | null, () => void]> = [
      ["an erroring adapter", () => throws, () => {}],
      ["an adapter that does not answer in time", () => hangs, () => {}],
      ["no adapter", () => null, () => {}],
      ["an exhausted budget", () => yes, () => __setEngageStateForTests(memoryEngageState({ dailyBudget: () => 0 }))],
      ["an open breaker", () => yes, () => __setEngageBreakerForTests({ allow: () => null, success() {}, failure() {}, release() {}, state: "open" } as CircuitBreaker)],
    ];
    for (const [name, adapter, prep] of cases) {
      it(`${name}: a drop, and the handler is not held past the deadline`, async () => {
        prep();
        const g = (gw = makeGw(adapter()));
        const t0 = Date.now();
        await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100));
        expect(Date.now() - t0).toBeLessThan(3000);
        await settle();
        expect(g.sends).toEqual([]);
        expect(actCount("acted") - beforeActed).toBe(0);
      });
    }
  });

  it("a model pass gives the engagement back: the next plain reply is recorded, not run", async () => {
    const g = (gw = makeGw(null));
    const root = nowTs(-100);
    g.state.thread = [m(root, WORLD.manager, "context")];
    g.setPlan([PASS]);
    await deliver(g, NAMED, nextTs(), root);
    await settle();
    expect(g.sends).toHaveLength(1);
    await deliver(g, "and what about staging, does that have the same problem?", nextTs(), root);
    await settle();
    expect(g.sends).toHaveLength(2);
    expect(g.sends[1]!.text).toMatch(/do NOT reply/i);
  });

  it("a model reply keeps the thread engaged: the next plain reply runs as an ordinary turn", async () => {
    const g = (gw = makeGw(null));
    const root = nowTs(-100);
    g.state.thread = [m(root, WORLD.manager, "context")];
    g.setPlan([REPLY]);
    await deliver(g, NAMED, nextTs(), root);
    await settle();
    await deliver(g, "and what about staging, does that have the same problem?", nextTs(), root);
    await settle();
    expect(g.sends).toHaveLength(2);
    expect(g.sends[1]!.text).not.toMatch(/do NOT reply/i);
    expect(g.sends[1]!.text).not.toContain(IMPLICIT_NOTE);
  });

  it("an implicit turn is not forced to reply by the must-reply guard; a mention turn still is", async () => {
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.guard(g.sends[0]!.id)).toBeNull();
    await g.emit("message", { event: { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: TEAM, ts: nextTs(), text: "<@USLAUDEBOT> hello there" }, client: g.client, context: { teamId: TEAM } });
    await settle();
    expect(g.sends.length).toBe(2);
    // A mention is a person's turn again on the same route: the guard applies.
    expect(g.sends[1]!.text).not.toContain(IMPLICIT_NOTE);
    expect(g.guard(g.sends[1]!.id)).toBe(MUST_REPLY_INSTRUCTION);
  });
});

describe("phase 2: a root question at contribute waits, then acts from the timer", () => {
  const ask = async (g: Gw, ts: string) => {
    setEngage("contribute", "on");
    __setDebounceForTests(20);
    await deliver(g, "how do we roll back the release safely today?", ts);
    await Bun.sleep(100);
    await settle();
  };
  it("still there and unanswered: the agent takes part, replying under the question", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    g.state.after = [m(ts, WORLD.manager, "how do we roll back the release safely today?")];
    await ask(g, ts);
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain(IMPLICIT_NOTE);
    expect(g.sends[0]!.text).toContain(`thread_ts="${ts}"`);
  });
  it("answered by a colleague meanwhile: nothing runs", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    g.state.after = [m(ts, WORLD.manager, "q", { reply_users: ["U0COLLEAGUE"] })];
    await ask(g, ts);
    expect(g.sends).toEqual([]);
  });
});

describe("phase 2: nothing changes unless the mode is on", () => {
  const baseline = async (setup: () => void) => {
    setup();
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs());
    await settle();
    return g;
  };
  it("mode shadow: no turn, no session, no Slack call beyond what the observer always made", async () => {
    const g = await baseline(() => setEngage("addressed", "shadow"));
    expect(g.sends).toEqual([]);
    expect(g.slack).toEqual([]);
    expect(Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions"))?.n)).toBe(0);
    expect(actCount("acted") - beforeActed).toBe(0);
  });
  it("level mention: nothing at all", async () => {
    const g = await baseline(() => setEngage("mention", "on"));
    expect(g.sends).toEqual([]);
    expect(g.slack).toEqual([]);
  });
  it("mode shadow with an adapter still only classifies in shadow: the agent does nothing", async () => {
    setEngage("addressed", "shadow");
    const g = (gw = makeGw(yes));
    g.state.thread = [m(nowTs(-50), WORLD.manager, "context")];
    await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100));
    await settle();
    expect(asked).toHaveLength(1);
    expect(g.sends).toEqual([]);
    expect(g.slack.filter((c) => c === "chat.postMessage" || c === "reactions.add")).toEqual([]);
  });
  it("the kill switch forces shadow at decision time, and is counted", async () => {
    const g = (gw = makeGw(null));
    process.env.SLAUDE_ENGAGE_FORCE_SHADOW = "1";
    const before = actCount("forced_shadow");
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toEqual([]);
    expect(actCount("forced_shadow") - before).toBe(1);
    // Read again for each message: unset, the next one acts.
    delete process.env.SLAUDE_ENGAGE_FORCE_SHADOW;
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toHaveLength(1);
  });
  it("the per channel act cap: past it a run is a pass, and counted", async () => {
    process.env.SLAUDE_ENGAGE_ACT_PER_HOUR = "2";
    const g = (gw = makeGw(null));
    const before = actCount("cap");
    for (let i = 0; i < 3; i++) await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toHaveLength(2);
    expect(actCount("cap") - before).toBe(1);
  });
});

describe("phase 2: the same access checks as a mention", () => {
  it("a blocked author never acts", async () => {
    await Grants.create({ persona: "default", subjectKind: "user", subjectId: "U0BLOCKED1", role: "member", deny: true, createdBy: WORLD.manager });
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs(), undefined, "U0BLOCKED1");
    await settle();
    expect(g.sends).toEqual([]);
    expect(actCount("acted") - beforeActed).toBe(0);
  });
  it("a /1on1 thread never acts", async () => {
    const root = nowTs(-100);
    await OneOnOne.lock({ channelId: CH, threadTs: root, lockedUser: WORLD.manager, createdBy: WORLD.manager });
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs(), root);
    await settle();
    expect(g.sends).toEqual([]);
  });
  it("a restricted channel never acts", async () => {
    setEngage("addressed", "on", "C0UNLISTED");
    const g = (gw = makeGw(null, { channel: "C0UNLISTED" }));
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toEqual([]);
  });
});

describe("phase 2: channel sessions", () => {
  it("an unmentioned root message whose decision is run is not suppressed: one turn, replying at the root", async () => {
    __setProactiveSoulSource(() => `\n## Channel <#${CH}>\n### Session\n- Mode: channel\n`);
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain(IMPLICIT_NOTE);
    expect(g.sends[0]!.text).not.toMatch(/do NOT reply/i);
    await g.surfaces.at(-1)!.reply({ text: "on it" });
    expect(g.posts.at(-1)!.thread_ts).toBeUndefined();
  });
  it("a root message with no run decision is still recorded suppressed", async () => {
    __setProactiveSoulSource(() => `\n## Channel <#${CH}>\n### Session\n- Mode: channel\n`);
    const g = (gw = makeGw(null));
    await deliver(g, "just a status note for the channel", nextTs());
    await settle();
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toMatch(/do NOT reply/i);
  });
  it("in shadow the same message is recorded suppressed, as before", async () => {
    __setProactiveSoulSource(() => `\n## Channel <#${CH}>\n### Session\n- Mode: channel\n`);
    setEngage("addressed", "shadow");
    const g = (gw = makeGw(null));
    await deliver(g, NAMED, nextTs());
    await settle();
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toMatch(/do NOT reply/i);
  });
});

describe("phase 2: one owner per message across personas", () => {
  const yaml = (name: string, user: string) => `
name: ${name}
slackUserId: ${user}
soul: You are ${name}.
access:
  channels:
    trusted: [${CH}]
channels:
  ${CH}: { engage: { level: addressed, mode: on } }
`;
  const persona = (name: string, user: string): Persona => {
    const { spec } = parseAgentYaml(name, yaml(name, user));
    const { soulData: sd, ...definition } = spec.definition;
    return { name, slackUserId: user, soulMd: spec.soul, config: { slackUserId: user, name }, outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null, soulJson: sd, definition } as Persona;
  };
  it("two personas that both decide run for one message: one act, one lost claim", async () => {
    const ps = [persona("ana", "UANA1"), persona("robin", "UROBIN")];
    setPersonaRegistry({
      lookupByUserId: (id) => ps.find((p) => p.slackUserId === id) ?? null,
      lookupByName: (n) => ps.find((p) => p.name === n) ?? null,
      list: () => ps,
      isMultiPersonaMode: () => true,
      isManaged: () => true,
      tombstonedPersonaFor: () => null,
      defaultPersona: () => ({ model: null, mcp: null, definition: null }),
    } as PersonaRegistry);
    const g = (gw = makeGw(null));
    const root = nowTs(-100);
    const at = nowTs(-30);
    // Both spoke at the same moment: neither follows the other, so both decide run (tier 2).
    for (const p of ps) await lastSpeakers().put({ channel: CH, thread: root, persona: p.name }, { ts: at, persona: p.name, app: "", repliedToUser: WORLD.manager });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const lost = actCount("lost_claim");
    const ts = nextTs();
    const event = { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: TEAM, ts, thread_ts: root, text: "can you check production too?" };
    await Promise.all(ps.map((p) => g.emit("message", { event, client: g.client, context: { teamId: TEAM, apiAppId: `A0${p.name.toUpperCase()}`, personaId: p.name } })));
    await settle();
    const acts = log.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("[engage] act "));
    log.mockRestore();
    expect(acts).toHaveLength(1);
    expect(actCount("lost_claim") - lost).toBe(1);
  });
});
