// R40-I5: a persona's outbound Slack client follows its current token. The
// per-persona surface factory was cached by persona name for the life of the
// process, so a sync that rotated or removed a userToken kept posting with the
// old client until restart.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";

const TEAM = "T";
const CH = "C0PUB";
const ANA = "UTESTANA1";

function fakeClient(label: string, posted: string[]) {
  return {
    auth: { test: async () => ({ user_id: ANA, team: "T", url: "x" }) },
    chat: {
      postMessage: async () => { posted.push(label); return { ok: true, ts: "9.9" }; },
      update: async () => { posted.push(`${label}:update`); return { ok: true }; },
    },
    reactions: { add: async () => { posted.push(`${label}:react`); return { ok: true }; }, remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Ana" } }), profile: { set: async () => ({}) } },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
}

function capturingTransport(posted: string[]) {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: fakeClient("bot", posted),
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  (t.client as any).auth.test = async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" });
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, emit };
}

const registryWith = (token: string, client: any): PersonaRegistry => {
  const ana = { name: "ana", slackUserId: ANA, soulMd: "ana soul", config: { slackUserId: ANA, name: "ana", userToken: token }, outClient: client };
  return {
    lookupByUserId: (id) => (id === ANA ? ana : null),
    lookupByName: (n) => (n === "ana" ? ana : null),
    list: () => [ana],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
};

const CACHE_DIR = join(paths.home, "cache");
const savedBot = process.env.SLACK_BOT_TOKEN;
beforeEach(() => {
  // Read when a forwarded message is handled; any non-empty placeholder will do.
  process.env.SLACK_BOT_TOKEN ||= "test-bot-token-placeholder";
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  __resetSoulDataMemo();
  writeSoulFixture(WORLD);
});
afterEach(() => {
  if (savedBot === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedBot;
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("a persona's outbound client after a token rotation", () => {
  // R41 (I5): the SAME thread before and after. A route (and the in-process
  // surface MCP bound to its surface at boot) outlives a registry install, so
  // a test on a fresh thread after the rotation would miss the stale client.
  it("an existing route's surface posts, reactions and later replies all use the new client", async () => {
    const posted: string[] = [];
    const { t, emit } = capturingTransport(posted);
    const agent = new AgentManager();
    const sent: string[] = [];
    agent.sendMessage = mock(async (sid: string) => { sent.push(sid); }) as any;
    createGateway(agent, t, {});

    const postTodo = (sessionId: string) =>
      agent.emit("event", { type: "toolCall", sessionId, tool: "TodoWrite", input: { todos: [{ content: "x", status: "pending", activeForm: "x" }] } });
    const replied = (sessionId: string) =>
      agent.emit("event", { type: "toolCall", sessionId, tool: "mcp__slaude_surface__reply", input: {} });
    const thread = `${Date.now()}.300`;
    const say = (ts: string, text: string) => emit("message", {
      event: { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: TEAM, ts, thread_ts: thread, text },
      client: t.client, context: { teamId: TEAM },
    });

    setPersonaRegistry(registryWith("token-one-placeholder", fakeClient("old", posted)));
    await say(thread, `<@${ANA}> hi`);
    expect(sent).toHaveLength(1);
    const sid = sent[0]!;
    postTodo(sid);
    await Bun.sleep(20);
    expect(posted).toContain("old");

    // Rotate. No new inbound message: the route built before the rotation is
    // the one the warm session's surface MCP holds.
    posted.length = 0;
    setPersonaRegistry(registryWith("token-two-placeholder", fakeClient("new", posted)));
    postTodo(sid);
    replied(sid); // a user-visible tool call sets the working reaction via ctx.client
    await Bun.sleep(30);
    // The todo message already exists, so the surface edits it (chat.update).
    expect(posted).toContain("new:update");
    expect(posted).toContain("new:react");
    expect(posted.filter((p) => p.startsWith("old"))).toEqual([]);

    // A later reply in the same thread reuses the route and stays on the new client.
    posted.length = 0;
    await say(`${Date.now()}.301`, `<@${ANA}> again`);
    expect(sent[sent.length - 1]).toBe(sid);
    postTodo(sid);
    await Bun.sleep(20);
    expect(posted.filter((p) => p.startsWith("old"))).toEqual([]);
    expect(posted.some((p) => p.startsWith("new"))).toBe(true);
  });
});

// R41 (I4): a warm route of a persona a managed install retired posts nothing,
// through neither the persona's old client nor the default bot.
describe("a warm route whose persona is retired", () => {
  it("is dropped on the managed install; later events for it post nothing", async () => {
    const posted: string[] = [];
    const { t, emit } = capturingTransport(posted);
    const agent = new AgentManager();
    const sent: string[] = [];
    agent.sendMessage = mock(async (sid: string) => { sent.push(sid); }) as any;
    createGateway(agent, t, {});
    const postTodo = (sessionId: string) =>
      agent.emit("event", { type: "toolCall", sessionId, tool: "TodoWrite", input: { todos: [{ content: "x", status: "pending", activeForm: "x" }] } });

    setPersonaRegistry(registryWith("token-one-placeholder", fakeClient("old", posted)));
    await emit("message", {
      event: { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: TEAM, ts: `${Date.now()}.500`, text: `<@${ANA}> hi` },
      client: t.client, context: { teamId: TEAM },
    });
    expect(sent).toHaveLength(1);

    setPersonaRegistry({
      lookupByUserId: () => null, lookupByName: () => null, list: () => [], isMultiPersonaMode: () => false,
      isManaged: () => true, tombstonedPersonaFor: (id) => (id === ANA ? "ana" : null),
    });
    posted.length = 0;
    postTodo(sent[0]!);
    agent.emit("event", { type: "toolCall", sessionId: sent[0]!, tool: "mcp__slaude_surface__reply", input: {} });
    await Bun.sleep(30);
    expect(posted).toEqual([]);
  });
});
