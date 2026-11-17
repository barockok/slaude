import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import * as Ignores from "../../../src/db/ignores";
import * as Grants from "../../../src/db/agent-grants";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter, DecisionRequest } from "../../../src/decision/types";
import { __setEngageBreakerForTests, __setEngageStateForTests } from "../../../src/gateway/engage/budget";
import { shadowIdle } from "../../../src/gateway/engage/shadow";
import { __setLastSpeakerStoreForTests } from "../../../src/gateway/engage/last-speaker";

ensureGuardrailKeyForPg();

/**
 * Implicit engagement, phase 1, through the real handler: the shadow classifier
 * is asked about a tier 3 candidate with a scrubbed input, and nothing the agent
 * does changes.
 */
const TEAM = "T";
const CH = "C0TEAM";
const PASSWORD_RULE = "---\nname: inbound-care\ndescription: d\n---\n```rules\n- id: no-passwords\n  on: inbound\n  match: { text: '(?i)password\\s*[:=]' }\n  action: deny\n  message: no\n```";

type Msg = Record<string, unknown>;
function makeGw(adapter: DecisionAdapter | null) {
  const events = new Map<string, (args: any) => Promise<void>>();
  const calls = { replies: 0, history: 0 };
  const state: { thread: Msg[]; history: Msg[] } = { thread: [], history: [] };
  const client: any = {
    auth: { test: async () => ({ user_id: "USLAUDEBOT", user: "quill", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: {
      info: async () => ({}), members: async () => ({}),
      replies: async () => (calls.replies++, { ok: true, messages: state.thread, response_metadata: { next_cursor: "" } }),
      history: async () => (calls.history++, { ok: true, messages: [...state.history].reverse() }),
    },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: (n: string, fn: any) => void events.set(n, fn) };
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const gateRunner = makeGateRunner({ mode: "off", adapter, tAct: 0.8, timeoutMs: 400, contextMessages: 8, log: () => {} });
  const h = createGateway(agent, t, { gateRunner });
  return { client, emit: async (n: string, a: any) => { await events.get(n)?.(a); }, sends, h, calls, state };
}
type Gw = ReturnType<typeof makeGw>;

const m = (ts: string, user: string, text: string, extra: Msg = {}) => ({ ts, user, text, ...extra });
const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
let seq = 0;
const nextTs = () => nowTs(++seq);
const deliver = (g: Gw, text: string, ts: string, thread?: string, user = WORLD.manager) =>
  g.emit("message", { event: { type: "message", channel: CH, channel_type: "channel", user, team: TEAM, ts, ...(thread ? { thread_ts: thread } : {}), text }, client: g.client, context: { teamId: TEAM } });
const settle = async () => { await Bun.sleep(30); await shadowIdle(); };

let asked: DecisionRequest[] = [];
const yes: DecisionAdapter = { name: "scripted-test", decide: async (req) => (asked.push(req), Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "alreadyAnswered" ? "no" : "yes", confidence: 0.95 }]))) };

const CLEAN = ["sessions", "seen_events", "pending_gates", "ignores", "agent_grants"];
let gw: Gw | null = null;
beforeEach(async () => {
  asked = [];
  writeSoulFixture(WORLD);
  setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "addressed", mode: "on" }] }));
  __setEngageStateForTests(null);
  __setEngageBreakerForTests(null);
  for (const t of CLEAN) await db.run(`DELETE FROM ${t}`);
  await OneOnOne._wipeForTests();
});
afterEach(async () => {
  await gw?.h.stop();
  gw = null;
  __setEngageStateForTests(null);
  __setLastSpeakerStoreForTests(null);
  __resetSoulDataMemo();
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("phase 1 through the handler", () => {
  it("a tier 3 message in a thread: one adapter call, one replies read, a scrubbed input, and the agent does nothing", async () => {
    await Grants.create({ persona: "default", subjectKind: "user", subjectId: "U0BLOCKED1", role: "member", deny: true, createdBy: WORLD.manager });
    await Ignores.create({ targetType: "user", userId: "U0IGNORED1", teamId: TEAM, createdBy: WORLD.manager });
    await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: PASSWORD_RULE, source: "file" }], by: "test" });
    __resetGuardrailSnapshotsForTests();
    await refreshGuardrails();
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    const ts = nextTs();
    g.state.thread = [
      m(root, WORLD.manager, "the deploy is stuck again"),
      m(nowTs(-90), "U0BLOCKED1", "blocked author text"),
      m(nowTs(-80), "U0IGNORED1", "ignored author text"),
      m(nowTs(-70), WORLD.manager, "my password: hunter2"),
      { ts: nowTs(-60), bot_id: "B0CIBOT", subtype: "bot_message", text: "pipeline 4412 failed" },
      m(nowTs(-50), WORLD.manager, "a fine message"),
      m(ts, WORLD.manager, "I wonder what quill thinks"),
    ];
    await deliver(g, "I wonder what quill thinks", ts, root);
    await settle();
    expect(g.sends).toEqual([]); // the agent was never run
    expect(asked).toHaveLength(1);
    expect(g.calls).toEqual({ replies: 1, history: 0 });
    const state = JSON.stringify((asked[0] as any).state);
    expect(state).toContain("<agent> thinks");
    expect(state).toContain("the deploy is stuck again");
    expect(state).toContain("a fine message");
    expect(state).not.toMatch(/quill|blocked author|ignored author|hunter2|pipeline 4412/i);
  });

  it("a root candidate at contribute: one history read, no replies read", async () => {
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "contribute", mode: "shadow" }] }));
    const g = (gw = makeGw(yes));
    g.state.history = [m(nowTs(-20), WORLD.manager, "morning all"), { ts: nowTs(-10), bot_id: "B0CIBOT", subtype: "bot_message", text: "nightly job done" }];
    await deliver(g, "does anyone know how to roll back a release, quill?", nextTs());
    await settle();
    expect(g.sends).toEqual([]);
    expect(g.calls).toEqual({ replies: 0, history: 1 });
    expect(asked).toHaveLength(1);
    expect(JSON.stringify((asked[0] as any).state)).not.toMatch(/nightly job|quill/i);
  });

  it("with no adapter: nothing is read and nothing is asked", async () => {
    const g = (gw = makeGw(null));
    g.state.thread = [m(nowTs(-50), WORLD.manager, "context")];
    await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100));
    await deliver(g, "does anyone know, quill?", nextTs());
    await settle();
    expect(g.sends).toEqual([]);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
    expect(asked).toHaveLength(0);
  });

  it("a blocked author's own message is never sent", async () => {
    await Grants.create({ persona: "default", subjectKind: "user", subjectId: "U0BLOCKED1", role: "member", deny: true, createdBy: WORLD.manager });
    const g = (gw = makeGw(yes));
    await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100), "U0BLOCKED1");
    await settle();
    expect(asked).toHaveLength(0);
    expect(g.sends).toEqual([]);
  });

  it("an owner deny rule on the message itself keeps it from the classifier", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: PASSWORD_RULE, source: "file" }], by: "test" });
    __resetGuardrailSnapshotsForTests();
    await refreshGuardrails();
    const g = (gw = makeGw(yes));
    await deliver(g, "quill, what about my password: hunter2 ?", nextTs(), nowTs(-100));
    await settle();
    expect(asked).toHaveLength(0);
  });
});
