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

export interface HarnessOpts {
  ephemeralFails?: boolean;
  dmFails?: boolean;
  /** Make a chat.postMessage throw when this returns true for its arguments. */
  failPost?: (a: any) => boolean;
  /** Passed to createGateway (for the OAuth stubs and the like). */
  gateway?: Record<string, unknown>;
}

function richTransport(o: HarnessOpts = {}) {
  const actions: Array<{ id: string | RegExp; fn: (a: any) => Promise<void> }> = [];
  const viewHandlers = new Map<string, (a: any) => Promise<void>>();
  const viewsOpened: any[] = [];
  const posts: any[] = [];
  const updates: any[] = [];
  const ephemerals: any[] = [];
  const reacts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const clientFor = (bot: string): any => ({
    auth: { test: async () => ({ user_id: bot, bot_id: `B${bot}`, team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => {
        if (o.dmFails && a.channel === SENDER) throw new Error("dm failed");
        if (o.failPost?.(a)) throw new Error("post failed");
        const ts = `${Date.now()}.${posts.length}`;
        posts.push({ ...a, ts });
        return { ok: true, ts, channel: a.channel };
      },
      update: async (a: any) => { updates.push(a); return { ok: true }; },
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
    views: { open: async (a: any) => { viewsOpened.push(a); return { ok: true }; }, update: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  });
  const client = clientFor(BOT);
  const t: Transport = {
    client,
    action: (id: string | RegExp, fn: any) => void actions.push({ id, fn }),
    view: (id: string, fn: any) => void viewHandlers.set(id, fn),
    use: () => {},
    start: async () => {},
    stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  const responds: any[] = [];
  /** Click a button as `user`: the first registered handler whose id matches `actionId`. */
  const click = async (actionId: string, c: { value?: string; user: string; trigger?: string }) => {
    const h = actions.find((a) => (typeof a.id === "string" ? a.id === actionId : a.id.test(actionId)));
    if (!h) throw new Error(`no action handler for ${actionId}`);
    await h.fn({
      ack: async () => {},
      action: { action_id: actionId, value: c.value },
      body: { user: { id: c.user, team_id: "T" }, team: { id: "T" }, api_app_id: undefined, trigger_id: c.trigger ?? "TRIG" },
      respond: async (m: any) => void responds.push(m),
    });
  };
  /** Submit a modal as `user`. */
  const submit = async (callbackId: string, v: { metadata: string; fields: Record<string, string>; user: string }) => {
    const h = viewHandlers.get(callbackId);
    if (!h) throw new Error(`no view handler for ${callbackId}`);
    const values: any = {};
    for (const [block, val] of Object.entries(v.fields)) values[block] = { value: { value: val } };
    await h({
      ack: async () => {},
      view: { callback_id: callbackId, private_metadata: v.metadata, state: { values }, id: "V1", hash: "h" },
      body: { user: { id: v.user, team_id: "T" }, team: { id: "T" } },
    });
  };
  return { t, client, posts, updates, ephemerals, reacts, emit, viewsOpened, responds, click, submit };
}

export function makeGw(o: HarnessOpts = {}) {
  const cap = richTransport(o);
  const agent = new AgentManager();
  const sends: { id: string; text: string }[] = [];
  agent.sendMessage = async (id: string, text: string) => void sends.push({ id, text });
  agent.suppressNextTurn = () => {};
  const h = createGateway(agent, cap.t, { surfaceFactory: makeSlackSurfaceFactory(cap.client), ...(o.gateway ?? {}) } as any);
  return { ...cap, agent, sends, h };
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

