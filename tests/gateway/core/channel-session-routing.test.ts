/**
 * Channel session mode: for an agent in the mode, a root message that mentions
 * it runs a turn in the one channel session and replies at root; any other root
 * message is recorded there without running the model. Threads, DMs and
 * channels not in the mode take today's path.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { createGateway, panelDispatchMeta } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { SessionBinding, Surface } from "../../../src/gateway/core/surface";
import { makeSlackSurfaceFactory } from "../../../src/gateway/slack/surface";
import { db, type SessionRow } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import * as Ignores from "../../../src/db/ignores";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { paths } from "../../../src/config/home";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { channelSessionLabel } from "../../../src/web/shared/surfaces";
import type { GateRunner } from "../../../src/gateway/gate/runner";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { flushAudits } from "../../../src/audit/emit";
import { metrics } from "../../../src/metrics";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";

ensureGuardrailKeyForPg();

const DENY = "---\nname: inbound-care\ndescription: d\n---\n```rules\n- id: no-passwords\n  on: inbound\n  match: { text: '(?i)password\\s*[:=]' }\n  action: deny\n  message: Please do not paste passwords here.\n```";
const recordFailures = (): number => Number(metrics.render().split("\n").find((l) => l.startsWith("slaude_channel_session_record_failures_total"))?.split(" ").at(-1) ?? 0);

const MODE_BLOCK = (ch: string) => `\n## Channel <#${ch}>\n### Session\n- Mode: channel\n`;
const BOT = "U0BOT";
const SENDER = WORLD.manager;

function richTransport() {
  const posts: any[] = [];
  const ephemerals: any[] = [];
  const reacts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const clientFor = (bot: string): any => ({
    auth: { test: async () => ({ user_id: bot, bot_id: `B${bot}`, team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => { const ts = `${Date.now()}.${posts.length}`; posts.push({ ...a, ts }); return { ok: true, ts }; },
      update: async () => ({ ok: true }),
      postEphemeral: async (a: any) => { ephemerals.push(a); return { ok: true }; },
    },
    reactions: { add: async (a: any) => { reacts.push(a); return { ok: true }; }, remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  });
  const client = clientFor(BOT);
  const t: Transport = {
    client,
    action: () => {},
    use: () => {},
    start: async () => {},
    stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, client, clientFor, posts, ephemerals, reacts, emit };
}

type Gw = ReturnType<typeof makeGw>;
let current: Gw | null = null;

function makeGw(o: { apps?: Array<{ apiAppId: string; personaId: string }>; gateRunner?: GateRunner; panel?: any } = {}) {
  const cap = richTransport();
  if (o.apps) cap.t.apps = async () => o.apps!.map((a) => ({ ...a, teamId: "T", client: cap.client }));
  const agent = new AgentManager();
  const sends: { id: string; text: string }[] = [];
  const suppressed: string[] = [];
  agent.sendMessage = async (id: string, text: string) => void sends.push({ id, text });
  agent.suppressNextTurn = (id: string) => void suppressed.push(id);
  const bindings: SessionBinding[] = [];
  const surfaces: Surface[] = [];
  const real = makeSlackSurfaceFactory(cap.client);
  const h = createGateway(agent, cap.t, {
    ...(o.gateRunner ? { gateRunner: o.gateRunner } : {}),
    ...(o.panel ? { panel: o.panel } : {}),
    surfaceFactory: (b) => {
      bindings.push(b);
      const s = real(b);
      surfaces.push(s);
      return s;
    },
  });
  const g = { ...cap, agent, sends, suppressed, bindings, surfaces, h };
  current = g;
  return g;
}

let tsCounter = 500;
const nextTs = () => `${++tsCounter}.1`;

const rootArgs = (g: Gw, text: string, o: { ts?: string; user?: string; channel?: string; thread_ts?: string; files?: any[]; context?: any; client?: any } = {}) => ({
  event: {
    type: "message",
    channel: o.channel ?? "C1",
    channel_type: "channel",
    user: o.user ?? SENDER,
    team: "T",
    ts: o.ts ?? nextTs(),
    ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}),
    ...(o.files ? { files: o.files } : {}),
    text,
  },
  client: o.client ?? g.client,
  context: o.context ?? { teamId: "T" },
});

const row = async (id: string) => (await Sessions.findById(id))!;
const tick = () => new Promise((r) => setTimeout(r, 15));

const registry = (names: string[], users: Record<string, string> = {}): PersonaRegistry => {
  const personas = names.map((name) => ({ name, slackUserId: users[name] ?? `U0${name.toUpperCase()}`, config: { slackUserId: users[name] ?? `U0${name.toUpperCase()}`, name }, outClient: null }) as any);
  return {
    lookupByUserId: (id) => personas.find((p) => p.slackUserId === id) ?? null,
    lookupByName: (name) => personas.find((p) => p.name === name) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => true,
    isManaged: () => false,
    tombstonedPersonaFor: () => null,
  };
};

describe("channel session routing", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture({ ...WORLD, trusted: ["C1", "C2"] });
    appendFileSync(paths.soul, MODE_BLOCK("C1") + MODE_BLOCK("C3"));
  });

  afterEach(async () => {
    // No post anywhere carries the reserved key.
    for (const p of current?.posts ?? []) expect(String(p.thread_ts ?? "")).not.toContain("channel:");
    current = null;
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
    await db.run("DELETE FROM ignores").catch(() => {});
    await db.run("DELETE FROM pending_gates").catch(() => {});
  });

  it("a root mention runs in the channel session, replies at root, reacts on the message", async () => {
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> hello`, { ts }));
    expect(g.sends).toHaveLength(1);
    expect(g.suppressed).toHaveLength(0);
    const s = await row(g.sends[0]!.id);
    expect(s.slack_thread_ts).toBe("channel:C1");
    await g.surfaces.at(-1)!.reply({ text: "hi there" });
    expect(g.posts).toHaveLength(1);
    expect(g.posts[0].thread_ts).toBeUndefined();
    await tick();
    expect(g.reacts.some((r) => r.timestamp === ts)).toBe(true);
  });

  it("works in the agent's own folder for this channel", async () => {
    const g = makeGw();
    await g.emit("message", rootArgs(g, `<@${BOT}> hello`));
    expect((await row(g.sends[0]!.id)).working_dir).toContain("/proactive/channels/C1");
  });

  it("two root mentions reuse one session", async () => {
    const g = makeGw();
    await g.emit("message", rootArgs(g, `<@${BOT}> one`));
    await g.emit("message", rootArgs(g, `<@${BOT}> two`));
    expect(g.sends).toHaveLength(2);
    expect(g.sends[0]!.id).toBe(g.sends[1]!.id);
  });

  it("an unmentioned root message is recorded without a turn, and creates the session", async () => {
    const g = makeGw();
    await g.emit("message", rootArgs(g, "just chatting"));
    expect(g.sends).toHaveLength(1);
    expect(g.suppressed).toEqual([g.sends[0]!.id]);
    expect((await row(g.sends[0]!.id)).slack_thread_ts).toBe("channel:C1");
    await tick();
    expect(g.posts).toHaveLength(0);
    expect(g.reacts).toHaveLength(0);
    expect(g.sends[0]!.text).toContain("just chatting");
    expect(g.sends[0]!.text).not.toContain("disengaged");
  });

  it("a root message mentioning another person is recorded, and the session stays engaged", async () => {
    const g = makeGw();
    await g.emit("message", rootArgs(g, `<@${BOT}> first`));
    await g.emit("message", rootArgs(g, "<@U0PEER> can you look?"));
    expect(g.suppressed).toHaveLength(1);
    const id = g.sends[0]!.id;
    expect(g.sends[1]!.id).toBe(id);
    expect((await row(id)).engaged).toBe(1);
  });

  it("/compact with no mention at root is recorded and not executed", async () => {
    const g = makeGw();
    let compacted = 0;
    g.agent.triggerCommand = (() => { compacted++; return true; }) as any;
    await g.emit("message", rootArgs(g, "/compact"));
    expect(compacted).toBe(0);
    expect(g.suppressed).toHaveLength(1);
    expect(g.sends).toHaveLength(1);
    expect(g.sends[0]!.text).toContain("/compact");
    expect(g.posts).toHaveLength(0);
  });

  it("a root command with a mention is a normal command", async () => {
    const g = makeGw();
    await g.emit("message", rootArgs(g, `<@${BOT}> /help`));
    expect(g.sends).toHaveLength(0);
    expect(g.posts).toHaveLength(1);
  });

  it("a thread mention in the channel keeps its own session under the thread", async () => {
    const g = makeGw();
    const thread = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> in a thread`, { thread_ts: thread }));
    expect(g.sends).toHaveLength(1);
    expect((await row(g.sends[0]!.id)).slack_thread_ts).toBe(thread);
    await g.surfaces.at(-1)!.reply({ text: "threaded" });
    expect(g.posts[0].thread_ts).toBe(thread);
  });

  it("the same event through app_mention and message is one turn", async () => {
    const g = makeGw();
    const args = rootArgs(g, `<@${BOT}> once`);
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
    await g.emit("message", args);
    expect(g.sends).toHaveLength(1);
    expect(g.suppressed).toHaveLength(0);
  });

  it("two apps for two agents both record the same message", async () => {
    setPersonaRegistry(registry(["alpha", "beta"]));
    __setProactiveSoulSource((p) => (p ? MODE_BLOCK("C1") : ""));
    const g = makeGw();
    const ts = nextTs();
    const via = (persona: string) => rootArgs(g, "for the room", { ts, client: g.clientFor(`U0APP${persona.toUpperCase()}`), context: { teamId: "T", apiAppId: `A0${persona.toUpperCase()}`, personaId: persona } });
    await g.emit("message", via("alpha"));
    await g.emit("message", via("beta"));
    expect(g.sends).toHaveLength(2);
    expect(g.suppressed).toHaveLength(2);
    expect(g.sends[0]!.id).not.toBe(g.sends[1]!.id);
    expect((await row(g.sends[0]!.id)).persona_id).toBe("alpha");
    expect((await row(g.sends[1]!.id)).persona_id).toBe("beta");
  });

  it("a channel not in the mode keeps today's path", async () => {
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> hello`, { ts, channel: "C2" }));
    expect((await row(g.sends[0]!.id)).slack_thread_ts).toBe(ts);
    await g.surfaces.at(-1)!.reply({ text: "under the message" });
    expect(g.posts[0].thread_ts).toBe(ts);
  });

  it("a card for a root turn threads under the message", async () => {
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> do it`, { ts }));
    void g.bindings.at(-1)!.requestApproval({ summary: "may I?" }).catch(() => {});
    await tick();
    const card = g.posts.find((p) => p.blocks);
    expect(card).toBeDefined();
    expect(card.thread_ts).toBe(ts);
  });

  it("an attachment on an unmentioned root message is named, not downloaded", async () => {
    const g = makeGw();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await g.emit("message", rootArgs(g, "see this", { files: [{ id: "F1", name: "report.pdf", url_private: "https://files.example/report.pdf" }], context: { teamId: "T", botToken: "bot-token" } }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(g.sends[0]!.text).toContain("report.pdf");
  });

  it("an ignored or non-admitted sender is not recorded", async () => {
    const g = makeGw();
    await Ignores.create({ targetType: "user", userId: "U0IGNORED", createdBy: WORLD.manager });
    await g.emit("message", rootArgs(g, "ignored", { user: "U0IGNORED" }));
    // C3 is in the mode but grants nobody; a non-manager is not admitted there.
    await g.emit("message", rootArgs(g, "outsider", { user: "U0RANDO", channel: "C3" }));
    expect(g.sends).toHaveLength(0);
  });

  it("pass at root does not disengage or error", async () => {
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> thoughts?`, { ts }));
    const id = g.sends[0]!.id;
    g.agent.emit("event", { type: "toolCall", sessionId: id, tool: "mcp__slaude_surface__pass", input: {} } as any);
    g.agent.emit("event", { type: "done", sessionId: id } as any);
    await tick();
    expect((await row(id)).engaged).toBe(1);
    expect(g.posts).toHaveLength(0);
  });

  it("a recording during a running turn leaves that turn alone", async () => {
    const g = makeGw();
    const mention = nextTs();
    await g.emit("message", rootArgs(g, `<@${BOT}> work`, { ts: mention }));
    const id = g.sends[0]!.id;
    await g.emit("message", rootArgs(g, "chatter meanwhile", { user: "U0OTHER" }));
    const b = g.bindings.at(-1)!;
    expect(b.inboundRef).toBe(mention);
    expect(b.threadRef).toBeUndefined();
    expect(b.userId).toBe(SENDER);
    g.agent.emit("event", { type: "toolCall", sessionId: id, tool: "mcp__slaude_surface__reply", input: {} } as any);
    g.agent.emit("event", { type: "done", sessionId: id } as any);
    await tick();
    // The done reaction landed despite the recording behind it.
    expect(g.reacts.filter((r) => r.timestamp === mention).map((r) => r.name)).toContain("white_check_mark");
    const before = g.reacts.length;
    g.agent.emit("event", { type: "done", sessionId: id } as any);
    await tick();
    expect(g.reacts.length).toBe(before);
  });

  describe("recordings and running turns", () => {
    const done = (g: Gw, id: string) => g.agent.emit("event", { type: "done", sessionId: id } as any);
    const reactionsOn = (g: Gw, ts: string) => g.reacts.filter((r) => r.timestamp === ts).map((r) => r.name);

    it("after one of two queued turns ends, a recording still leaves the route alone", async () => {
      const g = makeGw();
      const m1 = nextTs();
      const m2 = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> first`, { ts: m1 }));
      await g.emit("message", rootArgs(g, `<@${BOT}> second`, { ts: m2 }));
      done(g, g.sends[0]!.id);
      await tick();
      await g.emit("message", rootArgs(g, "chatter", { user: "U0OTHER" }));
      const b = g.bindings.at(-1)!;
      expect(b.inboundRef).toBe(m2);
      expect(b.userId).toBe(SENDER);
    });

    it("a recording in flight when a mention arrives ends quietly, and the mention finishes normally", async () => {
      const g = makeGw();
      await g.emit("message", rootArgs(g, "chatter", { user: "U0OTHER" }));
      const id = g.sends[0]!.id;
      const m = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> work`, { ts: m }));
      done(g, id);
      await tick();
      expect(reactionsOn(g, m)).not.toContain("white_check_mark");
      done(g, id);
      await tick();
      expect(reactionsOn(g, m)).toContain("white_check_mark");
    });

    it("a session that has exited holds no running turn", async () => {
      const g = makeGw();
      await g.emit("message", rootArgs(g, `<@${BOT}> first`));
      g.agent.emit("sessionExit", g.sends[0]!.id);
      const r = nextTs();
      await g.emit("message", rootArgs(g, "chatter", { ts: r, user: "U0OTHER" }));
      expect(g.bindings.at(-1)!.inboundRef).toBe(r);
    });

    it("a console turn counts as running", async () => {
      const g = makeGw();
      await g.emit("message", rootArgs(g, `<@${BOT}> first`));
      const id = g.sends[0]!.id;
      done(g, id);
      await tick();
      await g.h.__panelChat!(await row(id), "operator note", "U0OPER");
      await g.emit("message", rootArgs(g, "chatter", { user: "U0OTHER" }));
      expect(g.bindings.at(-1)!.userId).toBe("U0OPER");
    });

    it("a mention of /compact counts as running", async () => {
      const g = makeGw();
      g.agent.triggerCommand = (() => true) as any;
      const m = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> first`, { ts: m }));
      done(g, g.sends[0]!.id);
      await tick();
      await g.emit("message", rootArgs(g, `<@${BOT}> /compact`));
      await g.emit("message", rootArgs(g, "chatter", { user: "U0OTHER" }));
      expect(g.bindings.at(-1)!.inboundRef).toBe(m);
    });

    it("a failed turn with a recording behind it does not end with a checkmark", async () => {
      const g = makeGw();
      const m = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> work`, { ts: m }));
      const id = g.sends[0]!.id;
      await g.emit("message", rootArgs(g, "chatter", { user: "U0OTHER" }));
      g.agent.emit("event", { type: "error", sessionId: id, error: "boom", code: "TURN_FAILED" } as any);
      await tick();
      done(g, id);
      await tick();
      expect(reactionsOn(g, m)).not.toContain("white_check_mark");
    });

    it("a recording that fails is counted, and says nothing in Slack", async () => {
      const g = makeGw();
      const r = nextTs();
      await g.emit("message", rootArgs(g, "chatter", { ts: r, user: "U0OTHER" }));
      const before = recordFailures();
      g.agent.emit("event", { type: "error", sessionId: g.sends[0]!.id, error: "boom", code: "TURN_FAILED" } as any);
      await tick();
      expect(recordFailures()).toBe(before + 1);
      expect(g.posts).toHaveLength(0);
      expect(reactionsOn(g, r)).toHaveLength(0);
    });
  });

  describe("what gets recorded", () => {
    it("a system message at root is not recorded, even one naming the bot", async () => {
      const g = makeGw();
      const sys = (subtype: string, text: string) => {
        const a = rootArgs(g, text);
        return { ...a, event: { ...a.event, subtype } };
      };
      await g.emit("message", sys("channel_join", `<@${SENDER}> has joined the channel`));
      await g.emit("message", sys("channel_topic", `<@${SENDER}> set the topic: ask <@${BOT}>`));
      expect(g.sends).toHaveLength(0);
      expect(g.posts).toHaveLength(0);
    });

    it("a file share and a /me message are recorded", async () => {
      const g = makeGw();
      for (const subtype of ["file_share", "me_message"]) {
        const a = rootArgs(g, `a ${subtype}`);
        await g.emit("message", { ...a, event: { ...a.event, subtype } });
      }
      expect(g.sends).toHaveLength(2);
      expect(g.suppressed).toHaveLength(2);
    });

    it("keeps the addressee in the recorded text, and records a bare mention", async () => {
      setPersonaRegistry(registry(["alpha"]));
      __setProactiveSoulSource(() => MODE_BLOCK("C1"));
      const g = makeGw();
      // The default agent is mentioned, alpha records what was said to it.
      await g.emit("message", rootArgs(g, `<@${BOT}> over to you`));
      const recorded = g.sends.filter((s) => s.text.includes("recorded for context only"));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.text).toContain(`<@${BOT}> over to you`);
      await g.emit("message", rootArgs(g, `<@${BOT}>`));
      const bare = g.sends.filter((s) => s.text.includes("recorded for context only"));
      expect(bare).toHaveLength(2);
      expect(bare[1]!.text).toContain(`<@${BOT}>`);
    });

    it("does not call auth.test per recording", async () => {
      const g = makeGw();
      let calls = 0;
      const real = g.client.auth.test;
      g.client.auth.test = async () => { calls++; return real(); };
      await g.emit("message", rootArgs(g, "one"));
      const after = calls;
      await g.emit("message", rootArgs(g, "two"));
      expect(calls).toBe(after);
    });

    it("one agent's failure does not lose the message for the others", async () => {
      setPersonaRegistry(registry(["alpha", "beta"]));
      __setProactiveSoulSource((p) => (p ? MODE_BLOCK("C1") : ""));
      const g = makeGw();
      const real = g.agent.ensureSession.bind(g.agent);
      g.agent.ensureSession = (async (k: any, o: any) => {
        if (k.persona_id === "alpha") throw new Error("boom");
        return real(k, o);
      }) as any;
      const before = recordFailures();
      await g.emit("message", rootArgs(g, "for the room"));
      expect(g.sends.map((s) => s.id)).toHaveLength(1);
      expect((await row(g.sends[0]!.id)).persona_id).toBe("beta");
      expect(recordFailures()).toBe(before + 1);
    });

    it("an owner guardrail drops a recording silently, and still audits", async () => {
      const g = makeGw();
      await db.run("DELETE FROM audit_events");
      await __clearGuardrailsForTests();
      __resetGuardrailSnapshotsForTests();
      await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: DENY, source: "file" }], by: "test" });
      await refreshGuardrails();
      try {
        await g.emit("message", rootArgs(g, "my password: nope", { user: "U0OTHER" }));
        await flushAudits();
        expect(g.sends).toHaveLength(0);
        expect(g.posts).toHaveLength(0);
        expect(g.ephemerals).toHaveLength(0);
        const rows = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'guardrail.inbound.%'`);
        expect(rows.map((r) => r.action)).toEqual(["guardrail.inbound.denied"]);
      } finally {
        await __clearGuardrailsForTests();
        __resetGuardrailSnapshotsForTests();
      }
    });

    it("a doubted root mention reacts and is recorded, tolerating already_reacted", async () => {
      const gateRunner = { mode: "on", contextMessages: 8, gate: async () => "record_doubt" } as unknown as GateRunner;
      const g = makeGw({ gateRunner });
      const ts = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> maybe`, { ts }));
      expect(g.reacts.filter((r) => r.timestamp === ts).map((r) => r.name)).toEqual(["thinking_face"]);
      expect(g.suppressed).toHaveLength(1);

      const real = g.client.reactions.add;
      g.client.reactions.add = async () => { throw Object.assign(new Error("x"), { data: { error: "already_reacted" } }); };
      const ts2 = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> again`, { ts: ts2 }));
      g.client.reactions.add = real;
      expect(g.suppressed).toHaveLength(2);
    });

    it("no ops panel notice under a recording", async () => {
      let notices = 0;
      const panel = {
        panelLock: { noticeOnce: async () => { notices++; return true; }, owner: async () => "op", clearNotice: async () => {} },
        pubsub: { appendEvent: async () => "1-0", onPanelResume: async () => async () => {}, onPanelHold: async () => async () => {}, publishPanelResume: async () => 0, publishPanelHold: async () => 0 },
        registry: { lookup: async () => null, countWarm: async () => 0 },
      } as any;
      const g = makeGw({ panel });
      await g.emit("message", rootArgs(g, "chatter"));
      expect(notices).toBe(0);
      expect(g.posts).toHaveLength(0);
    });
  });

  describe("a turn with no thread", () => {
    it("a permission card omits thread_ts instead of sending it empty", async () => {
      const g = makeGw();
      await g.h.__openPermissionForClaims!({ tenant: "default", persona: "default", session: "S1", team: "T", channel: "C1", thread: "", initiator: "U0OP", scope: "turn", exp: 9e9 } as any, { toolName: "Bash", input: { command: "ls" }, toolUseId: "tu-9" });
      const card = g.posts.find((p) => p.blocks);
      expect(card).toBeDefined();
      expect("thread_ts" in card && card.thread_ts !== undefined).toBe(false);
    });

    it("a default-target reaction with no inbound ts is skipped", async () => {
      const g = makeGw();
      const s = makeSlackSurfaceFactory(g.client)({ conversationId: "C1", threadRef: undefined, inboundRef: "", userId: "U", teamId: "T" } as any);
      await s.react!({ name: "wave" });
      await s.unreact!({ name: "wave" });
      expect(g.reacts).toHaveLength(0);
    });
  });

  describe("agents sharing one app", () => {
    it("a mention of the bot and a persona with both in the mode runs both once, recording nobody", async () => {
      setPersonaRegistry(registry(["alpha"]));
      __setProactiveSoulSource(() => MODE_BLOCK("C1"));
      const g = makeGw();
      const args = rootArgs(g, `<@${BOT}> <@U0ALPHA> both of you`);
      await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
      await g.emit("message", args);
      expect(g.sends).toHaveLength(2);
      expect(g.suppressed).toHaveLength(0);
    });

    it("a classic agent is not doubled when only another agent of this app is in the mode", async () => {
      setPersonaRegistry(registry(["alpha"]));
      __setProactiveSoulSource((p) => (p ? "" : MODE_BLOCK("C1")));
      const g = makeGw();
      const ts = nextTs();
      await g.emit("message", rootArgs(g, `<@${BOT}> hello`, { ts }));
      expect(g.sends).toHaveLength(1);
      expect((await row(g.sends[0]!.id)).slack_thread_ts).toBe("channel:C1");
      // A mention of the classic persona: that persona takes today's path, the
      // channel-mode agent records it.
      const ts2 = nextTs();
      await g.emit("message", rootArgs(g, "<@U0ALPHA> hello", { ts: ts2 }));
      const rows = await Promise.all(g.sends.slice(1).map((s) => row(s.id)));
      expect(rows.map((r) => r.slack_thread_ts).sort()).toEqual([ts2, "channel:C1"].sort());
      expect(g.suppressed).toHaveLength(1);
    });

    it("a persona with its own app is left to that app's copy", async () => {
      setPersonaRegistry(registry(["alpha"]));
      __setProactiveSoulSource(() => MODE_BLOCK("C1"));
      const g = makeGw({ apps: [{ apiAppId: "A0MAIN", personaId: "default" }, { apiAppId: "A0ALPHA", personaId: "alpha" }] });
      await g.emit("message", rootArgs(g, "for the room"));
      expect(g.sends).toHaveLength(1);
      expect((await row(g.sends[0]!.id)).persona_id).toBe("default");
    });
  });

  describe("operator panel", () => {
    const base = { id: "S1", slack_team_id: "T", slack_channel_id: "C1", persona_id: "default", slack_app_id: null } as unknown as SessionRow;

    it("a channel session's console turn posts at root and never carries the key", () => {
      const m = panelDispatchMeta({ ...base, slack_thread_ts: "channel:C1" } as SessionRow, "op", "2.0");
      expect(m.postTarget).toBe("channel");
      expect(m.channelSession).toBe(true);
      expect(m.threadTs).not.toContain("channel:");
      const archived = panelDispatchMeta({ ...base, slack_thread_ts: "channel-archived:C1:5" } as SessionRow, "op", "2.0");
      expect(archived.threadTs).not.toContain("channel");
    });

    it("a thread session's console turn is unchanged", () => {
      const m = panelDispatchMeta({ ...base, slack_thread_ts: "1.0" } as SessionRow, "op", "2.0");
      expect(m.threadTs).toBe("1.0");
      expect("postTarget" in m).toBe(false);
      expect("channelSession" in m).toBe(false);
    });

    it("a console turn on the live route replies at root", async () => {
      const g = makeGw();
      await g.emit("message", rootArgs(g, `<@${BOT}> hello`));
      const id = g.sends[0]!.id;
      await g.h.__panelChat!(await row(id), "operator note", "U0OPER");
      await g.surfaces.at(-1)!.reply({ text: "from the console" });
      expect(g.posts.at(-1).thread_ts).toBeUndefined();
    });
  });
});

describe("console label", () => {
  it("names a channel session, live or archived", () => {
    expect(channelSessionLabel("channel:C1")).toBe("Channel session");
    expect(channelSessionLabel("channel-archived:C1:5")).toBe("Channel session (archived)");
    expect(channelSessionLabel("wake:a:1")).toBeNull();
    expect(channelSessionLabel(null)).toBeNull();
  });
});
