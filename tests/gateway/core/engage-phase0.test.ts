import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo, setSoulData, soulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import { metrics } from "../../../src/metrics";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter } from "../../../src/decision/types";
import { __setLastSpeakerStoreForTests, memoryLastSpeakerStore, type LastSpeakerStore } from "../../../src/gateway/engage/last-speaker";
import { deliver } from "../../../src/gateway/slack/outbound";

/**
 * Implicit engagement, phase 0: counters only. The ladder runs at the
 * handler's final drop for a channel that opted in; nothing the agent does
 * changes, and no adapter is ever called.
 */

const TEAM = "T";
const CH = "C0TEAM"; // trusted channel in WORLD

function makeTransport() {
  const events = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  return { t, emit: async (name: string, args: any) => { await events.get(name)?.(args); } };
}

/** A scripted adapter that fails the test if it is ever asked anything. */
let adapterCalls = 0;
const forbidden: DecisionAdapter = { name: "forbidden", decide: async () => { adapterCalls++; throw new Error("the adapter must not be called in phase 0"); } };

function makeGw() {
  const cap = makeTransport();
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const gateRunner = makeGateRunner({ mode: "on", adapter: forbidden, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} });
  const h = createGateway(agent, cap.t, { gateRunner });
  return { ...cap, sends, h };
}

const human = (client: any, text: string, ts: string, o: { user?: string; thread?: string } = {}) => ({
  event: { type: "message", channel: CH, channel_type: "channel", user: o.user ?? WORLD.manager, team: TEAM, ts, ...(o.thread ? { thread_ts: o.thread } : {}), text },
  client,
  context: { teamId: TEAM },
});

/** The value of slaude_engage_total for one label set, from the rendered exposition. */
function engaged(tier: string, outcome: string, level: string): number {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_engage_total{") && l.includes(`tier="${tier}"`) && l.includes(`outcome="${outcome}"`) && l.includes(`level="${level}"`));
  return line ? Number(line.split(" ").at(-1)) : 0;
}
const totalEngaged = () => metrics.render().split("\n").filter((l) => l.startsWith("slaude_engage_total{")).reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);

function configureEngage(level: "addressed" | "contribute" | null) {
  writeSoulFixture(WORLD);
  if (!level) return;
  setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level, mode: "shadow" }] }));
}

const nowTs = (offset = 0) => `${Math.floor(Date.now() / 1000) + offset}.000100`;
let seq = 0;
const nextTs = () => nowTs(++seq);

let store: LastSpeakerStore & { takes: number; puts: number };
const savedDefault = process.env.SLAUDE_ENGAGE_DEFAULT;

beforeEach(async () => {
  delete process.env.SLAUDE_ENGAGE_DEFAULT;
  adapterCalls = 0;
  const inner = memoryLastSpeakerStore();
  store = { takes: 0, puts: 0, put: async (...a) => { store.puts++; return inner.put(...a); }, take: async (p) => { store.takes++; return inner.take(p); } };
  __setLastSpeakerStoreForTests(store);
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM pending_gates");
  OneOnOne._wipeForTests();
});

afterEach(() => {
  __setLastSpeakerStoreForTests(null);
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
  if (savedDefault === undefined) delete process.env.SLAUDE_ENGAGE_DEFAULT;
  else process.env.SLAUDE_ENGAGE_DEFAULT = savedDefault;
});

describe("phase 0, unconfigured", () => {
  it("reads no record, counts nothing, writes no record, calls no adapter", async () => {
    configureEngage(null);
    const g = makeGw();
    const before = totalEngaged();
    const logs = spyOn(console, "log");
    const root = nextTs();
    await deliver("an answer", { kind: "reply", channel: CH, thread: { channel: CH, threadTs: root }, replyTo: WORLD.manager }, { post: async () => nowTs(1) });
    await g.emit("message", { event: { type: "message", channel: CH, channel_type: "channel", user: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, ts: nowTs(2), thread_ts: root, text: "an answer" }, client: g.t.client, context: { teamId: TEAM } });
    await g.emit("message", human(g.t.client, "can you also check staging?", nextTs(), { thread: root }));
    expect(store.takes).toBe(0);
    expect(store.puts).toBe(0);
    expect(totalEngaged()).toBe(before);
    expect(logs.mock.calls.some((c) => String(c[0]).includes("[engage]"))).toBe(false);
    expect(adapterCalls).toBe(0);
    logs.mockRestore();
  });
});

describe("phase 0, addressed in shadow", () => {
  it("a reply following the agent's answer counts tier 2 run; behavior is unchanged (dropped); no adapter call", async () => {
    configureEngage("addressed");
    const g = makeGw();
    const root = nextTs();
    // The agent answers through the outbound choke point, as a reply to the person.
    await deliver("an answer", { kind: "reply", channel: CH, thread: { channel: CH, threadTs: root }, replyTo: WORLD.manager }, { post: async () => nowTs(1) });
    expect(store.puts).toBe(1);
    const before = engaged("2", "run", "addressed");
    const logs = spyOn(console, "log");
    await g.emit("message", human(g.t.client, "can you also check staging?", nextTs(), { thread: root }));
    expect(engaged("2", "run", "addressed")).toBe(before + 1);
    expect(logs.mock.calls.some((c) => String(c[0]).includes(`[engage] phase0 channel=${CH} level=addressed tier=2 would=run reason=follows_agent`))).toBe(true);
    logs.mockRestore();
    expect(g.sends).toEqual([]); // the agent was never run
    expect(adapterCalls).toBe(0);
  });

  it("the record is read and cleared by the first human message only", async () => {
    configureEngage("addressed");
    const g = makeGw();
    const root = nextTs();
    await deliver("an answer", { kind: "reply", channel: CH, thread: { channel: CH, threadTs: root }, replyTo: WORLD.manager }, { post: async () => nowTs(1) });
    await g.emit("message", human(g.t.client, "can you also check staging?", nextTs(), { thread: root }));
    const run2 = engaged("2", "run", "addressed");
    await g.emit("message", human(g.t.client, "and what about production?", nextTs(), { thread: root }));
    expect(engaged("2", "run", "addressed")).toBe(run2);
    expect(store.takes).toBe(2);
  });

  it("the agent's echo alone records a speaker without a person answered (classify, not run)", async () => {
    configureEngage("addressed");
    const g = makeGw();
    const root = nextTs();
    await g.emit("message", { event: { type: "message", channel: CH, channel_type: "channel", user: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, ts: nowTs(1), thread_ts: root, text: "an answer" }, client: g.t.client, context: { teamId: TEAM } });
    expect(store.puts).toBe(1);
    const before = engaged("3", "classify", "addressed");
    await g.emit("message", human(g.t.client, "can you also check staging?", nextTs(), { thread: root }));
    expect(engaged("3", "classify", "addressed")).toBe(before + 1);
    expect(g.sends).toEqual([]);
  });

  it("a message naming a colleague counts tier 0 pass", async () => {
    configureEngage("addressed");
    const g = makeGw();
    const before = engaged("0", "pass", "addressed");
    await g.emit("message", human(g.t.client, "Budi, can you look at the deploy?", nextTs()));
    expect(engaged("0", "pass", "addressed")).toBe(before + 1);
    expect(g.sends).toEqual([]);
    expect(adapterCalls).toBe(0);
  });

  it("a Redis-style failure in the store fails open and never reaches the handler", async () => {
    configureEngage("addressed");
    __setLastSpeakerStoreForTests({ put: async () => { throw new Error("down"); }, take: async () => { throw new Error("down"); } });
    const g = makeGw();
    await g.emit("message", human(g.t.client, "can you check staging?", nextTs()));
    expect(g.sends).toEqual([]);
  });

  it("a slow record read is cut off at the budget", async () => {
    configureEngage("addressed");
    __setLastSpeakerStoreForTests({ put: async () => {}, take: () => new Promise(() => {}) });
    const g = makeGw();
    const t0 = Date.now();
    await g.emit("message", human(g.t.client, "can you check staging?", nextTs()));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
