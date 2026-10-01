import { randomBytes } from "node:crypto";
import { signSlackRequest } from "../../../src/gateway/slack/verify";
import type { FakeApp, FakeMessage, Workspace } from "./workspace";

export function signedHeaders(secret: string, raw: string, contentType: string, nowMs: number = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlackRequest(secret, ts, raw),
  };
}

/** The `event_callback` envelope Slack POSTs to /slack/events for a message. */
export function messageEnvelope(ws: Workspace, app: FakeApp, msg: FakeMessage, opts: { eventId?: string } = {}): Record<string, unknown> {
  const channel = ws.channels.get(msg.channel);
  return {
    token: "fake-verification-token",
    team_id: ws.teamId,
    api_app_id: app.apiAppId,
    type: "event_callback",
    event_id: opts.eventId ?? `Ev${randomBytes(6).toString("hex").toUpperCase()}`,
    event_time: Math.floor(Number(msg.ts)),
    event: {
      type: "message",
      channel: msg.channel,
      channel_type: channel?.isIm ? "im" : "channel",
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      event_ts: msg.ts,
      team: ws.teamId,
      ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
    },
    authorizations: [{ enterprise_id: null, team_id: ws.teamId, user_id: app.botUserId, is_bot: true, is_enterprise_install: false }],
    is_ext_shared_channel: false,
  };
}

/** The `block_actions` interaction payload Slack sends when a button is pressed. */
export function blockActionsPayload(i: {
  ws: Workspace;
  app: FakeApp;
  user: string;
  channel: string;
  messageTs: string;
  actionId: string;
  value?: string;
  blockId?: string;
  responseUrl: string;
}): Record<string, unknown> {
  const name = i.ws.users.get(i.user)?.name ?? i.user;
  return {
    type: "block_actions",
    token: "fake-verification-token",
    api_app_id: i.app.apiAppId,
    team: { id: i.ws.teamId, domain: "fake" },
    user: { id: i.user, username: name, name, team_id: i.ws.teamId },
    channel: { id: i.channel, name: i.ws.channels.get(i.channel)?.name ?? i.channel },
    container: { type: "message", message_ts: i.messageTs, channel_id: i.channel, is_ephemeral: false },
    trigger_id: `${Date.now()}.${randomBytes(4).toString("hex")}`,
    message: { type: "message", user: i.app.botUserId, ts: i.messageTs, text: "" },
    response_url: i.responseUrl,
    actions: [
      {
        type: "button",
        block_id: i.blockId ?? "b0",
        action_id: i.actionId,
        text: { type: "plain_text", text: "Button" },
        value: i.value ?? "",
        action_ts: String(Date.now() / 1000),
      },
    ],
  };
}

export interface DeliverOptions {
  fetchFn?: typeof fetch;
  /** Slack waits about 3 seconds for an acknowledgement. */
  ackTimeoutMs?: number;
  /** Delay before each retry; its length is the number of retries (Slack: 3). */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Mark the FIRST delivery as a retry (X-Slack-Retry-Num), for dedup tests. */
  retryNum?: number;
}

export interface DeliveryAttempt {
  retryNum: number;
  status: number | "timeout" | "error";
}
export interface DeliveryResult {
  attempts: DeliveryAttempt[];
  finalStatus: number | "timeout" | "error";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attempt(
  url: string,
  secret: string,
  raw: string,
  contentType: string,
  o: DeliverOptions,
  retryNum: number,
  reason?: string,
): Promise<DeliveryAttempt> {
  const fetchFn = o.fetchFn ?? fetch;
  const headers = signedHeaders(secret, raw, contentType, (o.nowMs ?? Date.now)());
  if (retryNum > 0) {
    headers["x-slack-retry-num"] = String(retryNum);
    headers["x-slack-retry-reason"] = reason ?? "http_error";
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.ackTimeoutMs ?? 3000);
  try {
    const res = await fetchFn(url, { method: "POST", headers, body: raw, signal: ctl.signal });
    return { retryNum, status: res.status };
  } catch (e) {
    return { retryNum, status: ctl.signal.aborted ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

const ok2xx = (s: DeliveryAttempt["status"]) => typeof s === "number" && s >= 200 && s < 300;

/** Deliver an Events API envelope, retrying like Slack does on failure. */
export async function deliverEvent(url: string, secret: string, envelope: object, o: DeliverOptions = {}): Promise<DeliveryResult> {
  const raw = JSON.stringify(envelope); // signed and sent as the SAME string
  const sleep = o.sleep ?? realSleep;
  const attempts: DeliveryAttempt[] = [];
  let last = await attempt(url, secret, raw, "application/json", o, o.retryNum ?? 0);
  attempts.push(last);
  const delays = o.retryDelaysMs ?? [0, 60_000, 300_000];
  for (let i = 0; i < delays.length && !ok2xx(last.status); i++) {
    await sleep(delays[i]!);
    last = await attempt(url, secret, raw, "application/json", o, i + 1, last.status === "timeout" ? "http_timeout" : "http_error");
    attempts.push(last);
  }
  return { attempts, finalStatus: last.status };
}

/** Deliver an interaction (button press). Slack does not retry these. */
export async function deliverInteraction(url: string, secret: string, payload: object, o: DeliverOptions = {}): Promise<DeliveryResult> {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const a = await attempt(url, secret, raw, "application/x-www-form-urlencoded", o, 0);
  return { attempts: [a], finalStatus: a.status };
}
