import type { Transport, WebClientLike, ActionHandler, EventHandler, Middleware } from "../core/transport";

export interface OutboundCard {
  kind: "message" | "approval" | "permission" | "status" | "reaction";
  channel: string;
  threadTs?: string;
  text?: string;
  blocks?: any[];
  actionIds: string[];
  resolved: boolean;
  raw: any;
}

function extractActionIds(blocks: any[] | undefined): string[] {
  if (!Array.isArray(blocks)) return [];
  const ids: string[] = [];
  for (const b of blocks) {
    if (b?.type === "actions" && Array.isArray(b.elements)) {
      for (const el of b.elements) if (el?.action_id) ids.push(el.action_id);
    }
  }
  return ids;
}

function classify(actionIds: string[]): OutboundCard["kind"] {
  if (actionIds.some((a) => a.startsWith("slaude_appr:"))) return "approval";
  if (actionIds.some((a) => a.startsWith("slaude_perm:"))) return "permission";
  return "message";
}

export class SimTransport implements Transport {
  outbound: OutboundCard[] = [];
  client: WebClientLike;
  #events = new Map<string, EventHandler>();
  #actions: Array<{ id: string | RegExp; h: ActionHandler }> = [];
  #users: Record<string, string>;
  #botUserId: string;
  #seq = 0;
  #cardCbs: Array<(c: OutboundCard) => void> = [];

  /** Subscribe to every outbound card as it is pushed (live render / gate detection).
   *  Returns an unsubscribe fn. */
  onCard(cb: (c: OutboundCard) => void): () => void {
    this.#cardCbs.push(cb);
    return () => { this.#cardCbs = this.#cardCbs.filter((f) => f !== cb); };
  }

  constructor(opts: { users?: Record<string, string>; botUserId?: string } = {}) {
    this.#users = opts.users ?? {};
    this.#botUserId = opts.botUserId ?? "U_SLAUDE";
    const push = (kind: OutboundCard["kind"], channel: string, threadTs: string | undefined, text: string | undefined, blocks: any[] | undefined, raw: any) => {
      const actionIds = extractActionIds(blocks);
      const card: OutboundCard = { kind, channel, threadTs, text, blocks, actionIds, resolved: false, raw };
      this.outbound.push(card);
      for (const cb of this.#cardCbs) cb(card);
      return { ok: true, ts: `${++this.#seq}.0` };
    };
    this.client = {
      auth: { test: async () => ({ ok: true, user_id: this.#botUserId, bot_id: "B_SLAUDE", team: "T_SIM", url: "https://sim" }) },
      chat: {
        postMessage: async (a: any) => push(classify(extractActionIds(a.blocks)), a.channel, a.thread_ts, a.text, a.blocks, a),
        update: async (a: any) => push("message", a.channel, a.ts, a.text, a.blocks, a),
      },
      reactions: {
        add: async (a: any) => push("reaction", a.channel, a.timestamp, `:${a.name}:`, undefined, a),
        remove: async () => ({ ok: true }),
      },
      conversations: {
        info: async (a: any) => ({ ok: true, channel: { id: a.channel } }),
        members: async () => ({ ok: true, members: [] }),
        replies: async () => ({ ok: true, messages: [] }),
      },
      users: { info: async (a: any) => ({ ok: true, user: { id: a.user, real_name: this.#users[a.user] ?? a.user } }), profile: { set: async () => ({ ok: true }) } },
      search: { messages: async () => ({ ok: true, messages: { matches: [] } }) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    } as any;
  }

  action(idOrRegex: string | RegExp, h: ActionHandler) { this.#actions.push({ id: idOrRegex, h }); }
  event(name: string, h: EventHandler) { this.#events.set(name, h); }
  use(_mw: Middleware) { /* sim ignores diagnostic middleware */ }
  async start() {}
  async stop() {}

  async feedMessage(raw: { channel: string; user: string; text: string; channel_type?: string; thread_ts?: string; ts?: string; team?: string }) {
    const ts = raw.ts ?? `${++this.#seq}.5`;
    const event = {
      type: "message", channel: raw.channel, user: raw.user, text: raw.text,
      channel_type: raw.channel_type, thread_ts: raw.thread_ts, ts, team: raw.team,
    };
    const args = { event, client: this.client, context: { teamId: raw.team } };
    if (raw.text.includes(`<@${this.#botUserId}>`)) {
      await this.#events.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    }
    await this.#events.get("message")?.(args);
  }

  async feedAction(actionId: string, byUser: string) {
    const entry = this.#actions.find((a) => (typeof a.id === "string" ? a.id === actionId : a.id.test(actionId)));
    if (!entry) throw new Error(`no action handler matches ${actionId}`);
    const respond = async (msg: any) => {
      if (msg?.replace_original) {
        for (let i = this.outbound.length - 1; i >= 0; i--) {
          if (!this.outbound[i]!.resolved && this.outbound[i]!.actionIds.includes(actionId)) { this.outbound[i]!.resolved = true; break; }
        }
      }
      this.outbound.push({ kind: "message", channel: "(respond)", text: msg?.text, blocks: msg?.blocks, actionIds: extractActionIds(msg?.blocks), resolved: false, raw: msg });
    };
    await entry.h({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: byUser } }, respond });
  }
}
