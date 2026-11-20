/**
 * Gateway-generated command replies are private: an ephemeral to the sender, a DM when
 * that fails, never the thread. State changes other people must know about keep one
 * short public line.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { makeSlackSurfaceFactory } from "../../../src/gateway/slack/surface";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { paths } from "../../../src/config/home";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";

ensureGuardrailKeyForPg();

const BOT = "U0BOT";
const SENDER = WORLD.manager;

function richTransport(o: { ephemeralFails?: boolean; dmFails?: boolean } = {}) {
  const posts: any[] = [];
  const ephemerals: any[] = [];
  const reacts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const clientFor = (bot: string): any => ({
    auth: { test: async () => ({ user_id: bot, bot_id: `B${bot}`, team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => {
        if (o.dmFails && a.channel === SENDER) throw new Error("dm failed");
        const ts = `${Date.now()}.${posts.length}`;
        posts.push({ ...a, ts });
        return { ok: true, ts };
      },
      update: async () => ({ ok: true }),
      postEphemeral: async (a: any) => {
        if (o.ephemeralFails) throw Object.assign(new Error("x"), { data: { error: "user_not_in_channel" } });
        ephemerals.push(a);
        return { ok: true };
      },
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
  return { t, client, posts, ephemerals, reacts, emit };
}

function makeGw(o: { ephemeralFails?: boolean; dmFails?: boolean } = {}) {
  const cap = richTransport(o);
  const agent = new AgentManager();
  agent.sendMessage = async () => {};
  agent.suppressNextTurn = () => {};
  createGateway(agent, cap.t, { surfaceFactory: makeSlackSurfaceFactory(cap.client) });
  return { ...cap, agent };
}
type Gw = ReturnType<typeof makeGw>;

let tsCounter = 900;
const nextTs = () => `${++tsCounter}.1`;
const threadMsg = (g: Gw, text: string, thread: string) => ({
  event: { type: "message", channel: "C1", channel_type: "channel", user: SENDER, team: "T", ts: nextTs(), thread_ts: thread, text },
  client: g.client,
  context: { teamId: "T" },
});
const tick = () => new Promise((r) => setTimeout(r, 15));

describe("private command replies", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture({ ...WORLD, trusted: ["C1"] });
  });
  afterEach(() => {
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
    delete process.env.SLAUDE_PRIVATE_NOTICES;
  });

  it("/help in a thread is an ephemeral to the sender and nothing is posted", async () => {
    const g = makeGw();
    const thread = nextTs();
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, thread));
    await tick();
    expect(g.posts).toHaveLength(0);
    expect(g.ephemerals).toHaveLength(1);
    expect(g.ephemerals[0].user).toBe(SENDER);
    expect(g.ephemerals[0].thread_ts).toBe(thread);
    expect(String(g.ephemerals[0].text)).toContain("/mode");
  });

  it("when the ephemeral is refused the reply is a DM, never the thread", async () => {
    const g = makeGw({ ephemeralFails: true });
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
    expect(g.posts.filter((p) => p.channel === SENDER)).toHaveLength(1);
  });

  it("when both fail nothing is posted anywhere and the sender gets the error reaction", async () => {
    const g = makeGw({ ephemeralFails: true, dmFails: true });
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.posts).toHaveLength(0);
  });

  it("a state change keeps one short public line, the rest of the reply is private", async () => {
    const g = makeGw();
    await g.emit("message", threadMsg(g, `<@${BOT}> /mode plan`, nextTs()));
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(1);
    expect(String(g.posts[0].text)).toContain("plan");
    expect(g.ephemerals).toHaveLength(0);
  });

  it("with SLAUDE_PRIVATE_NOTICES off, /help is posted publicly as before", async () => {
    process.env.SLAUDE_PRIVATE_NOTICES = "off";
    const g = makeGw();
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.ephemerals).toHaveLength(0);
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(1);
  });
});
