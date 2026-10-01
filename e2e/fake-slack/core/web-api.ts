import type { CallLog } from "./call-log";
import { redactArgs } from "./call-log";
import type { SchemaGuard } from "./schema-guard";
import { SlackError, type FakeMessage, type Workspace } from "./workspace";

export interface ApiResult {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FaultRule {
  /** A method name, or "*" for any method. */
  method: string;
  status: number;
  retryAfterSec?: number;
  times: number;
}

export class FaultStore {
  #rules: FaultRule[] = [];
  add(rule: FaultRule): void {
    this.#rules.push({ ...rule });
  }
  clear(): void {
    this.#rules = [];
  }
  /** Take one use of the first matching rule, if any. */
  consume(method: string): FaultRule | undefined {
    const i = this.#rules.findIndex((r) => r.times > 0 && (r.method === "*" || r.method === method));
    if (i < 0) return undefined;
    const rule = this.#rules[i]!;
    rule.times -= 1;
    if (rule.times <= 0) this.#rules.splice(i, 1);
    return rule;
  }
}

const JSON_FIELDS = ["blocks", "attachments", "metadata"];

/** Decode a Web API request body (form or JSON) into plain params. */
export function parseParams(contentType: string | null, raw: string): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if ((contentType ?? "").includes("application/json")) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) out = v as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (raw) {
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  }
  for (const k of JSON_FIELDS) {
    const v = out[k];
    if (typeof v === "string") {
      try {
        out[k] = JSON.parse(v);
      } catch {}
    }
  }
  return out;
}

type Params = Record<string, unknown>;
type Handler = (p: Params, ctx: { ws: Workspace; botUserId: string; appId: string }) => Record<string, unknown>;

const str = (p: Params, k: string): string | undefined => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : undefined);

function need(p: Params, k: string, err = "invalid_arguments"): string {
  const v = str(p, k);
  if (v === undefined) throw new SlackError(err);
  return v;
}

function apiMessage(ws: Workspace, m: FakeMessage): Record<string, unknown> {
  const replyCount = m.threadTs ? 0 : ws.messages(m.channel).filter((x) => x.threadTs === m.ts).length;
  return {
    type: "message",
    user: m.user,
    text: m.text,
    ts: m.ts,
    ...(m.threadTs ? { thread_ts: m.threadTs } : replyCount ? { thread_ts: m.ts, reply_count: replyCount } : {}),
    ...(m.appId ? { app_id: m.appId, bot_id: `B${m.appId.slice(1)}` } : {}),
    ...(m.blocks ? { blocks: m.blocks } : {}),
    ...(m.reactions.size
      ? { reactions: [...m.reactions].map(([name, users]) => ({ name, count: users.size, users: [...users] })) }
      : {}),
  };
}

const HANDLERS: Record<string, Handler> = {
  "auth.test": (_p, { ws, botUserId }) => ({
    ok: true,
    url: "https://fake.invalid/",
    team: "Fake Team",
    user: ws.users.get(botUserId)?.name ?? "agent",
    team_id: ws.teamId,
    user_id: botUserId,
    bot_id: `B${botUserId.slice(1)}`,
  }),
  "chat.postMessage": (p, { ws, botUserId, appId }) => {
    const channel = need(p, "channel", "channel_not_found");
    if (str(p, "text") === undefined && p.blocks === undefined) throw new SlackError("no_text");
    const m = ws.post({ channel, user: botUserId, text: str(p, "text") ?? "", blocks: p.blocks, threadTs: str(p, "thread_ts"), appId });
    return { ok: true, channel, ts: m.ts, message: apiMessage(ws, m) };
  },
  "chat.update": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    const m = ws.update(channel, need(p, "ts", "message_not_found"), { text: str(p, "text"), blocks: p.blocks });
    return { ok: true, channel, ts: m.ts, text: m.text, message: apiMessage(ws, m) };
  },
  "chat.delete": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    const ts = need(p, "ts", "message_not_found");
    ws.remove(channel, ts);
    return { ok: true, channel, ts };
  },
  "chat.postEphemeral": (p, { ws }) => ({
    ok: true,
    message_ts: ws.postEphemeral(need(p, "channel", "channel_not_found"), need(p, "user", "user_not_found"), str(p, "text") ?? ""),
  }),
  "reactions.add": (p, { ws, botUserId }) => {
    ws.react(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"), need(p, "name", "invalid_name"), botUserId);
    return { ok: true };
  },
  "reactions.remove": (p, { ws, botUserId }) => {
    ws.unreact(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"), need(p, "name", "invalid_name"), botUserId);
    return { ok: true };
  },
  "users.info": (p, { ws }) => {
    const u = ws.users.get(need(p, "user", "user_not_found"));
    if (!u) throw new SlackError("user_not_found");
    return {
      ok: true,
      user: { id: u.id, team_id: ws.teamId, name: u.name, real_name: u.name, is_bot: u.isBot, profile: { display_name: u.name, real_name: u.name } },
    };
  },
  "users.profile.set": () => ({ ok: true }),
  "conversations.replies": (p, { ws }) => {
    const msgs = ws.replies(need(p, "channel", "channel_not_found"), need(p, "ts", "thread_not_found"));
    return { ok: true, messages: msgs.map((m) => apiMessage(ws, m)), has_more: false };
  },
  "conversations.info": (p, { ws }) => {
    const ch = ws.channels.get(need(p, "channel", "channel_not_found"));
    if (!ch) throw new SlackError("channel_not_found");
    return {
      ok: true,
      channel: {
        id: ch.id,
        name: ch.name,
        is_channel: !ch.isIm,
        is_im: ch.isIm,
        is_member: true,
        topic: { value: ch.topic },
        purpose: { value: ch.purpose },
      },
    };
  },
  "conversations.members": (p, { ws }) => ({
    ok: true,
    members: ws.members(need(p, "channel", "channel_not_found")),
    response_metadata: { next_cursor: "" },
  }),
  "conversations.setTopic": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    ws.setTopic(channel, str(p, "topic") ?? "");
    return { ok: true, channel: { id: channel } };
  },
  "conversations.setPurpose": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    ws.setPurpose(channel, str(p, "purpose") ?? "");
    return { ok: true, channel: { id: channel } };
  },
  "search.messages": (p, { ws }) => {
    const hits = ws.search(str(p, "query") ?? "");
    return {
      ok: true,
      query: str(p, "query") ?? "",
      messages: { total: hits.length, matches: hits.map((m) => ({ ...apiMessage(ws, m), channel: { id: m.channel } })) },
    };
  },
  "pins.add": (p, { ws }) => {
    ws.pin(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"));
    return { ok: true };
  },
  "pins.remove": (p, { ws }) => {
    ws.unpin(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"));
    return { ok: true };
  },
  "files.info": () => {
    throw new SlackError("file_not_found");
  },
  "assistant.threads.setStatus": () => ({ ok: true }),
};

export const KNOWN_METHODS: readonly string[] = Object.keys(HANDLERS);

export function createWebApi(
  ws: Workspace,
  log: CallLog,
  faults: FaultStore,
  guard?: SchemaGuard,
): (method: string, params: Params, bearer: string | null) => ApiResult {
  return (method, params, bearer) => {
    const token = bearer ?? (typeof params.token === "string" ? params.token : null);
    const app = token ? ws.appByToken(token) : undefined;
    const args = redactArgs(params);
    // violations are only recorded in the call log: the response is never changed by the guard
    const requestViolations = guard ? guard.checkRequest(method, params) : [];
    const done = (status: number, body: Record<string, unknown>, headers?: Record<string, string>, unknown?: boolean): ApiResult => {
      const schemaViolations = guard ? [...requestViolations, ...guard.checkResponse(method, body)] : [];
      log.add({
        ...(schemaViolations.length ? { schemaViolations } : {}),
        kind: "api",
        method,
        app: app?.apiAppId,
        ok: body.ok === true,
        error: typeof body.error === "string" ? body.error : undefined,
        status,
        args,
        ...(unknown ? { unknown: true } : {}),
      });
      return { status, body, ...(headers ? { headers } : {}) };
    };

    const fault = faults.consume(method);
    if (fault) {
      const headers = fault.retryAfterSec !== undefined ? { "retry-after": String(fault.retryAfterSec) } : undefined;
      return done(fault.status, { ok: false, error: fault.status === 429 ? "ratelimited" : "fatal_error" }, headers);
    }
    if (!app) return done(200, { ok: false, error: "invalid_auth" });
    if (!Object.hasOwn(HANDLERS, method)) return done(200, { ok: false, error: "unknown_method" }, undefined, true);
    const handler = HANDLERS[method]!;
    try {
      return done(200, handler(params, { ws, botUserId: app.botUserId, appId: app.apiAppId }));
    } catch (e) {
      if (e instanceof SlackError) return done(200, { ok: false, error: e.code });
      return done(500, { ok: false, error: "fake_internal_error" });
    }
  };
}
