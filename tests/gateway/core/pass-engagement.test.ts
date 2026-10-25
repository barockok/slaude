import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
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
  const reacts: string[] = [];
  /** Reactions currently on each message, keyed `${ts}` → names (Slack-like:
   *  a second add of the same name is `already_reacted`). */
  const onMsg = new Map<string, Set<string>>();
  const statuses: string[] = [];
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.0` }), update: async () => ({ ok: true }) },
      reactions: {
        add: async (a: any) => {
          reacts.push(a.name);
          const set = onMsg.get(a.timestamp) ?? new Set<string>();
          onMsg.set(a.timestamp, set);
          if (set.has(a.name)) throw Object.assign(new Error("already_reacted"), { data: { error: "already_reacted" } });
          set.add(a.name);
          return { ok: true };
        },
        remove: async (a: any) => { onMsg.get(a.timestamp)?.delete(a.name); return { ok: true }; },
      },
      assistant: { threads: { setStatus: async (a: any) => { statuses.push(a.status); return { ok: true }; } } },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await events.get(name)?.(args); };
  const reactionsOn = (ts: string) => [...(onMsg.get(ts) ?? [])].sort();
  return { t, emit, reacts, reactionsOn, statuses };
}

type Step = string | { tool: string; input: Record<string, unknown> };

/** Gateway + a stubbed agent: each non-suppressed turn emits the planned tool
 *  calls, then `done`. A pass with `react` also adds that reaction to the
 *  inbound message, as the real pass handler does through the surface. */
function makeGw() {
  const cap = makeTransport();
  const agent = new AgentManager();
  const sends: string[] = [];
  let plan: Step[] = [];
  agent.sendMessage = async (id: string, txt: string) => {
    sends.push(txt);
    if (txt.includes("do NOT reply")) return;
    const inbound = /inbound_ts="([^"]+)"/.exec(txt)?.[1];
    for (const step of plan) {
      const { tool, input } = typeof step === "string" ? { tool: step, input: {} } : step;
      agent.emit("event", { type: "toolCall", sessionId: id, tool, input });
      if (tool === PASS && typeof input.react === "string") {
        try { await cap.t.client.reactions.add({ channel: CH, timestamp: inbound, name: input.react } as any); } catch {}
      }
    }
    agent.emit("event", { type: "done", sessionId: id });
  };
  const h = createGateway(agent, cap.t, {});
  return { ...cap, agent, sends, h, setPlan: (p: Step[]) => { plan = p; } };
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

  it("a failing disengage write is logged; the done clean-up still runs and no rejection escapes", async () => {
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => { rejections.push(r); };
    process.on("unhandledRejection", onRej);
    const real = Sessions.setEngaged;
    const spy = spyOn(Sessions, "setEngaged").mockImplementation(async (id: string, value: boolean) => {
      if (value === false) throw new Error("db down");
      return real(id, value);
    });
    try {
      const g = makeGw();
      g.setPlan([PASS]);
      await mention(g, nextTs(), "<@USLAUDEBOT> was great at that yesterday");
      await settle();
      expect(spy.mock.calls.some((c) => c[1] === false)).toBe(true); // the revert was attempted
      expect(g.statuses.at(-1)).toBe(""); // status still cleared after the failed write
      expect(rejections).toEqual([]);
    } finally {
      spy.mockRestore();
      process.off("unhandledRejection", onRej);
    }
  });

  it("an existing disengaged row stays disengaged after mention + pass", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([REPLY]);
    await mention(g, thread, "<@USLAUDEBOT> can you check this?");
    // Disengaged since (e.g. after a colleague was mentioned instead).
    await Sessions.setEngagedForThread({ team_id: TEAM, channel_id: CH, thread_ts: thread }, false);
    g.setPlan([PASS]);
    await mention(g, nextTs(), "<@USLAUDEBOT> was great at that yesterday", thread);
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.at(-1)).toContain("do NOT reply");
    expect((await Sessions.findAnyByThread({ team_id: TEAM, channel_id: CH, thread_ts: thread }))!.engaged).toBeFalsy();
  });

  it("the message copy arriving before app_mention still leaves the thread disengaged", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([PASS]);
    const args = msg(g.t.client, "<@USLAUDEBOT> was great at that yesterday", thread);
    await g.emit("message", args);
    await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
    await settle();
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.length).toBe(2);
    expect(g.sends.at(-1)).toContain("do NOT reply");
  });
});

describe("a passed turn is silent on Slack", () => {
  it("a plain pass leaves no reaction and no ✅", async () => {
    const g = makeGw();
    const ts = nextTs();
    g.setPlan([PASS]);
    await mention(g, ts, "<@USLAUDEBOT> was great at that yesterday");
    await settle();
    expect(g.reacts).not.toContain("white_check_mark");
    expect(g.reactionsOn(ts)).toEqual([]);
  });

  it("pass with react posts only that reaction (the received 👀 is replaced)", async () => {
    const g = makeGw();
    const ts = nextTs();
    g.setPlan([{ tool: PASS, input: { reason: "not for me", react: "thumbsup" } }]);
    await mention(g, ts, "<@USLAUDEBOT> was great at that yesterday");
    await settle();
    expect(g.reactionsOn(ts)).toEqual(["thumbsup"]);
  });

  it("pass with react eyes keeps that 👀 (same emoji as received)", async () => {
    const g = makeGw();
    const ts = nextTs();
    g.setPlan([{ tool: PASS, input: { reason: "noted", react: "eyes" } }]);
    await mention(g, ts, "<@USLAUDEBOT> was great at that yesterday");
    await settle();
    expect(g.reactionsOn(ts)).toEqual(["eyes"]);
  });

  it("a replied turn still ends with ✅", async () => {
    const g = makeGw();
    const ts = nextTs();
    g.setPlan([REPLY]);
    await mention(g, ts, "<@USLAUDEBOT> can you check this?");
    await settle();
    expect(g.reactionsOn(ts)).toContain("white_check_mark");
  });
});

describe("engagedBefore across a warm merge", () => {
  it("a follow-up merged mid-turn does not cancel the revert of a passing mention", async () => {
    const g = makeGw();
    const thread = nextTs();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    g.agent.sendMessage = async (id: string, txt: string) => {
      g.sends.push(txt);
      if (txt.includes("do NOT reply")) return;
      if (!first) return; // merged into the running turn
      first = false;
      void gate.then(() => {
        g.agent.emit("event", { type: "toolCall", sessionId: id, tool: PASS, input: {} });
        g.agent.emit("event", { type: "done", sessionId: id });
      });
    };
    await mention(g, thread, "<@USLAUDEBOT> was great at that yesterday");
    await g.emit("message", msg(g.t.client, "and the demo too", nextTs(), { thread }));
    release();
    await settle();
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.at(-1)).toContain("do NOT reply");
  });

  it("a later plain turn that passes does not reuse a finished turn's engagedBefore", async () => {
    const g = makeGw();
    const thread = nextTs();
    g.setPlan([REPLY]);
    await mention(g, thread, "<@USLAUDEBOT> can you check this?");
    g.setPlan([PASS]);
    await g.emit("message", msg(g.t.client, "thanks, that was all", nextTs(), { thread }));
    await settle();
    await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
    await settle();
    expect(g.sends.at(-1)).not.toContain("do NOT reply");
  });
});
