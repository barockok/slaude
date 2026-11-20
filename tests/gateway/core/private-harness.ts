/** A gateway wired to a fake Slack that records posts, ephemerals and reactions, for the private notice tests. */
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { makeSlackSurfaceFactory } from "../../../src/gateway/slack/surface";
import { WORLD } from "../../../src/gateway/sim/soul-fixture";
import { ensureGuardrailKeyForPg } from "../../guardrails/helpers";

ensureGuardrailKeyForPg();

export const BOT = "U0BOT";
export const SENDER = WORLD.manager;

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

export function makeGw(o: { ephemeralFails?: boolean; dmFails?: boolean } = {}) {
  const cap = richTransport(o);
  const agent = new AgentManager();
  const sends: { id: string; text: string }[] = [];
  agent.sendMessage = async (id: string, text: string) => void sends.push({ id, text });
  agent.suppressNextTurn = () => {};
  createGateway(agent, cap.t, { surfaceFactory: makeSlackSurfaceFactory(cap.client) });
  return { ...cap, agent, sends };
}
export type Gw = ReturnType<typeof makeGw>;

let tsCounter = 900;
export const nextTs = () => `${++tsCounter}.1`;
export const threadMsg = (g: Gw, text: string, thread: string) => ({
  event: { type: "message", channel: "C1", channel_type: "channel", user: SENDER, team: "T", ts: nextTs(), thread_ts: thread, text },
  client: g.client,
  context: { teamId: "T" },
});
export const tick = () => new Promise((r) => setTimeout(r, 15));

