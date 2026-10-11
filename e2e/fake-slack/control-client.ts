import type { CallRecord } from "./core/call-log";
import type { DeliveryResult } from "./core/inbound";
import type { FaultRule } from "./core/web-api";

export interface ControlApp {
  apiAppId: string;
  name: string;
  botUserId: string;
  botToken: string;
  signingSecret: string;
}

export interface ControlMessage {
  ts: string;
  user: string;
  text: string;
  blocks?: unknown;
  threadTs?: string;
}

interface SendCommon {
  app: string;
  channel: string;
  user: string;
  target: string;
  eventId?: string;
  duplicate?: boolean;
  retryNum?: number;
  /** Per-request override of the server's retry schedule (max 10 non-negative delays). */
  retryDelaysMs?: number[];
  /** Per-request override of the server's acknowledgement timeout. */
  ackTimeoutMs?: number;
}

/** Post a new human message and deliver its event. */
export interface NewMessageInput extends SendCommon {
  text: string;
  threadTs?: string;
  mention?: boolean;
  redeliverTs?: undefined;
}

/** Deliver the stored message with this ts again (no new post); `user` must be its author. */
export interface RedeliverInput extends SendCommon {
  redeliverTs: string;
}

export type SendInput = NewMessageInput | RedeliverInput;

export interface ClickInput {
  app: string;
  target: string;
  user: string;
  channel: string;
  messageTs: string;
  actionId: string;
  value?: string;
  retryDelaysMs?: number[];
  ackTimeoutMs?: number;
}

/** Typed wrappers over the fake's `/__fake/` control API. Non-2xx throws `<status> <error>`. */
export function createControlClient(baseUrl: string) {
  const root = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${root}/__fake/${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) throw new Error(`${res.status} ${parsed.error ?? text}`);
    return parsed as T;
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
    const s = usp.toString();
    return s ? `?${s}` : "";
  };

  return {
    addUser: (u: { id: string; name: string }) => call<{ id: string; name: string; isBot: boolean }>("POST", "users", u),
    /** Omitted credentials are generated fresh on every call; pass them to keep an app stable across calls. */
    addApp: (a: { apiAppId: string; name: string; botUserId?: string; botToken?: string; signingSecret?: string }) =>
      call<ControlApp>("POST", "apps", a),
    apps: () => call<{ apps: ControlApp[] }>("GET", "apps"),
    addChannel: (c: { id: string; name: string; isIm?: boolean; members?: string[] }) =>
      call<{ id: string; name: string; isIm: boolean; members: string[] }>("POST", "channels", c),
    send: (i: SendInput) => call<{ message: { ts: string; channel: string; threadTs?: string }; deliveries: DeliveryResult[] }>("POST", "send", i),
    click: (i: ClickInput) => call<{ delivery: DeliveryResult }>("POST", "click", i),
    thread: (channel: string, threadTs: string) => call<{ messages: ControlMessage[] }>("GET", `thread${q({ channel, threadTs })}`),
    messages: (channel: string) => call<{ messages: ControlMessage[] }>("GET", `messages${q({ channel })}`),
    calls: (filter: { method?: string; since?: number } = {}) => call<{ calls: CallRecord[] }>("GET", `calls${q(filter)}`),
    clearCalls: () => call<{ ok: true }>("DELETE", "calls"),
    addFault: (f: FaultRule) => call<{ ok: true }>("POST", "faults", f),
    clearFaults: () => call<{ ok: true }>("DELETE", "faults"),
    reset: () => call<{ ok: true }>("POST", "reset"),
  };
}
