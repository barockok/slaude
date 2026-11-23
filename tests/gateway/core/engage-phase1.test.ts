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
import * as Sessions from "../../../src/db/sessions";
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
import { __setConversationLogForTests, conversationLog, logKey } from "../../../src/gateway/engage/conversation-log";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";

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
  const sent = { replies: [] as any[], history: [] as any[], posts: 0 };
  const state: { thread: Msg[]; history: Msg[]; repliesError: unknown; moreRepliesPages: boolean; historyAfter?: (a: any) => Msg[] } = { thread: [], history: [], repliesError: null, moreRepliesPages: false };
  const client: any = {
    auth: { test: async () => ({ user_id: "USLAUDEBOT", user: "quill", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async () => (sent.posts++, { ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: {
      info: async () => ({}), members: async () => ({}),
      replies: async (a: any) => {
        calls.replies++;
        sent.replies.push(a);
        if (state.repliesError) throw state.repliesError;
        return { ok: true, messages: state.thread, response_metadata: { next_cursor: state.moreRepliesPages ? "more" : "" } };
      },
      history: async (a: any) => {
        calls.history++;
        sent.history.push(a);
        // A re-check asks from the message on (oldest); the input asks for what came before it (latest).
        if (a.oldest !== undefined) return { ok: true, messages: state.historyAfter ? state.historyAfter(a) : [] };
        return { ok: true, messages: [...state.history].reverse() };
      },
    },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: (n: string, fn: any) => void events.set(n, fn) };
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const gateRunner = makeGateRunner({ mode: "off", adapter, tAct: 0.8, timeoutMs: 400, contextMessages: 8, log: () => {} });
  // Engagement reads Slack through a lookup client built from a token: whatever token the environment holds, it is this fake.
  const h = createGateway(agent, t, { gateRunner, lookupClientFactory: () => client });
  return { client, emit: async (n: string, a: any) => { await events.get(n)?.(a); }, sends, h, calls, sent, state };
}
type Gw = ReturnType<typeof makeGw>;

const m = (ts: string, user: string, text: string, extra: Msg = {}) => ({ ts, user, text, ...extra });
const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
let seq = 0;
const nextTs = () => nowTs(++seq);
const deliver = (g: Gw, text: string, ts: string, thread?: string, user = WORLD.manager) =>
  g.emit("message", { event: { type: "message", channel: CH, channel_type: "channel", user, team: TEAM, ts, ...(thread ? { thread_ts: thread } : {}), text }, client: g.client, context: { teamId: TEAM } });
/** What the gateway heard earlier in a conversation (a thread, or null for the channel's top level), put in the conversation log. */
const seed = async (thread: string | null, msgs: Msg[]) => {
  for (const x of msgs) {
    await conversationLog().append(logKey("slack", CH, thread), { ref: String(x.ts), author: String(x.bot_id ?? x.user), isBot: Boolean(x.bot_id), text: String(x.text), ...(thread ? { threadRef: thread } : {}) });
  }
};
const settle = async () => { await Bun.sleep(30); await shadowIdle(); };

let asked: DecisionRequest[] = [];
const yes: DecisionAdapter = { name: "scripted-test", decide: async (req) => (asked.push(req), Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "alreadyAnswered" ? "no" : "yes", confidence: 0.95 }]))) };

const CLEAN = ["sessions", "seen_events", "pending_gates", "ignores", "agent_grants"];
const TOKEN_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLAUDE_SLACK_MODE", "SLAUDE_SLACK_API_URL"] as const;
const savedEnv = Object.fromEntries(TOKEN_ENV.map((k) => [k, process.env[k]]));
let gw: Gw | null = null;
beforeEach(async () => {
  for (const k of TOKEN_ENV) delete process.env[k];
  asked = [];
  __setConversationLogForTests(null);
  writeSoulFixture(WORLD);
  setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "addressed", mode: "shadow" }] }));
  __setEngageStateForTests(null);
  __setEngageBreakerForTests(null);
  for (const t of CLEAN) await db.run(`DELETE FROM ${t}`);
  await OneOnOne._wipeForTests();
});
afterEach(async () => {
  for (const k of TOKEN_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await gw?.h.stop();
  gw = null;
  __setEngageStateForTests(null);
  __setLastSpeakerStoreForTests(null);
  __setConversationLogForTests(null);
  __setProactiveSoulSource(null);
  __resetSoulDataMemo();
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("phase 1 through the handler", () => {
  it("a tier 3 message in a thread: one adapter call, context from the log and no Slack read, a scrubbed input, and the agent does nothing", async () => {
    await Grants.create({ persona: "default", subjectKind: "user", subjectId: "U0BLOCKED1", role: "member", deny: true, createdBy: WORLD.manager });
    await Ignores.create({ targetType: "user", userId: "U0IGNORED1", teamId: TEAM, createdBy: WORLD.manager });
    await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: PASSWORD_RULE, source: "file" }], by: "test" });
    __resetGuardrailSnapshotsForTests();
    await refreshGuardrails();
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    const ts = nextTs();
    await seed(root, [
      m(root, WORLD.manager, "the deploy is stuck again"),
      m(nowTs(-90), "U0BLOCKED1", "blocked author text"),
      m(nowTs(-80), "U0IGNORED1", "ignored author text"),
      m(nowTs(-70), WORLD.manager, "my password: hunter2"),
      { ts: nowTs(-60), bot_id: "B0CIBOT", subtype: "bot_message", text: "pipeline 4412 failed" },
      m(nowTs(-50), WORLD.manager, "a fine message"),
      m(ts, WORLD.manager, "I wonder what quill thinks"),
    ]);
    await deliver(g, "I wonder what quill thinks", ts, root);
    await settle();
    expect(g.sends).toEqual([]); // the agent was never run
    expect(asked).toHaveLength(1);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
    const state = JSON.stringify((asked[0] as any).state);
    expect(state).toContain("<agent> thinks");
    expect(state).toContain("the deploy is stuck again");
    expect(state).toContain("a fine message");
    expect(state).not.toMatch(/quill|blocked author|ignored author|hunter2|pipeline 4412/i);
  });

  it("a root candidate at contribute: context is the channel's log, no Slack read", async () => {
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "contribute", mode: "shadow" }] }));
    const g = (gw = makeGw(yes));
    await seed(null, [m(nowTs(-20), WORLD.manager, "morning all"), { ts: nowTs(-10), bot_id: "B0CIBOT", subtype: "bot_message", text: "nightly job done" }]);
    await deliver(g, "does anyone know how to roll back a release, quill?", nextTs());
    await settle();
    expect(g.sends).toEqual([]);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
    expect(asked).toHaveLength(1);
    expect(JSON.stringify((asked[0] as any).state)).toContain("morning all");
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

  it("a long log is read in one bounded step: only the newest few lines reach the classifier", async () => {
    const g = (gw = makeGw(yes));
    const root = nowTs(-500);
    await seed(root, Array.from({ length: 30 }, (_v, i) => m(nowTs(-400 + i), WORLD.manager, `line ${i + 1}`)));
    await deliver(g, "I wonder what quill thinks", nextTs(), root);
    await settle();
    const state = JSON.stringify((asked[0] as any).state);
    expect(state).toContain("line 30");
    expect(state).not.toContain("line 1\"");
    expect(state.match(/line \d+/g)!.length).toBeLessThanOrEqual(12);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
  });

  it("a /1on1 thread: nothing is asked and no budget is spent", async () => {
    const root = nowTs(-100);
    await OneOnOne.lock({ channelId: CH, threadTs: root, lockedUser: WORLD.manager, createdBy: WORLD.manager });
    const g = (gw = makeGw(yes));
    await deliver(g, "I wonder what quill thinks", nextTs(), root);
    await settle();
    expect(asked).toHaveLength(0);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
    expect(g.sends).toEqual([]);
  });

  it("messages the gateway heard are the context of the next candidate, with no Slack read", async () => {
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "contribute", mode: "shadow" }] }));
    const g = (gw = makeGw(yes));
    await deliver(g, "the staging deploy keeps failing", nextTs());
    await deliver(g, "same here, the migration step hangs", nextTs(), undefined, "U0OTHER001");
    await settle();
    asked = [];
    await deliver(g, "does anyone know how to roll back a release, quill?", nextTs());
    await settle();
    expect(asked).toHaveLength(1);
    const state = JSON.stringify((asked[0] as any).state);
    expect(state).toContain("the staging deploy keeps failing");
    expect(state).toContain("the migration step hangs");
    expect(g.calls).toEqual({ replies: 0, history: 0 });
    expect(g.sent.posts).toBe(0);
  });

  it("the agent's own earlier post is context (its side), another bot's is not", async () => {
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    await seed(root, [m(root, WORLD.manager, "why is staging red")]);
    await conversationLog().append(logKey("slack", CH, root), { ref: nowTs(-60), author: "", isBot: true, text: "it is the cache", threadRef: root, agent: "default" });
    await seed(root, [{ ts: nowTs(-50), bot_id: "B0CIBOT", text: "pipeline 9 failed" }]);
    await deliver(g, "I wonder what quill thinks", nextTs(), root);
    await settle();
    const state = JSON.stringify((asked[0] as any).state);
    expect(state).toContain('"role":"agent","text":"it is the cache"');
    expect(state).toContain("why is staging red");
    expect(state).not.toContain("pipeline 9");
  });

  it("an empty log is no reason to skip: the message is classified alone", async () => {
    const g = (gw = makeGw(yes));
    await deliver(g, "I wonder what quill thinks", nextTs(), nowTs(-100));
    await settle();
    expect(asked).toHaveLength(1);
    expect(g.calls).toEqual({ replies: 0, history: 0 });
  });

  it("a channel at level mention keeps no log", async () => {
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "mention", mode: "shadow" }] }));
    const g = (gw = makeGw(yes));
    await deliver(g, "something said here", nextTs());
    await settle();
    expect(await conversationLog().recent(logKey("slack", CH), 10)).toEqual([]);
  });

  it("a channel-session root message is observed at the channel_session site: asked once, nothing posted, the agent does nothing", async () => {
    __setProactiveSoulSource(() => `\n## Channel <#${CH}>\n### Session\n- Mode: channel\n`);
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelEngage: [{ channel: CH, level: "addressed", mode: "shadow" }] }));
    const g = (gw = makeGw(yes));
    await seed(null, [m(nowTs(-20), WORLD.manager, "morning all")]);
    await deliver(g, "I wonder what quill thinks", nextTs());
    await settle();
    expect(asked).toHaveLength(1);
    expect(g.calls.history).toBe(0);
    // Today's path for an unmentioned message in a channel session: one suppressed recording (the model does not run), nothing posted.
    expect(g.sends).toHaveLength(1);
    expect(g.sent.posts).toBe(0);
    // It went through the channel session (the message was recorded there, suppressed), not the classic drop path.
    expect(await Sessions.findByThread({ team_id: TEAM, channel_id: CH, thread_ts: `channel:${CH}`, persona_id: "default" })).toBeTruthy();
  });
});
