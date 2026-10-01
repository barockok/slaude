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

export interface SendInput {
  app: string;
  channel: string;
  user: string;
  text: string;
  target: string;
  threadTs?: string;
  mention?: boolean;
  eventId?: string;
  duplicate?: boolean;
  retryNum?: number;
}

export interface ClickInput {
  app: string;
  target: string;
  user: string;
  channel: string;
  messageTs: string;
  actionId: string;
  value?: string;
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
    addApp: (a: { apiAppId: string; name: string; botUserId?: string }) => call<ControlApp>("POST", "apps", a),
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
