import { beforeEach, expect, test } from "bun:test";
import { verifySlackSignature } from "../../../src/gateway/slack/verify";
import { blockActionsPayload, deliverEvent, deliverInteraction, messageEnvelope, signedHeaders } from "./inbound";
import { Workspace, type FakeApp } from "./workspace";

let ws: Workspace;
let app: FakeApp;

beforeEach(() => {
  ws = new Workspace("T0FAKE");
  app = ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT", signingSecret: "sekret" });
  ws.addUser("U0MGR", "manager");
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  ws.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
});

test("signedHeaders produces a signature the gateway's verifier accepts", () => {
  const raw = '{"a":1}';
  const h = signedHeaders("sekret", raw, "application/json", 1_700_000_000_000);
  expect(h["content-type"]).toBe("application/json");
  expect(
    verifySlackSignature({
      signingSecret: "sekret",
      rawBody: raw,
      timestamp: h["x-slack-request-timestamp"]!,
      signature: h["x-slack-signature"]!,
      nowMs: 1_700_000_000_000,
    }),
  ).toEqual({ ok: true });
  expect(
    verifySlackSignature({ signingSecret: "wrong", rawBody: raw, timestamp: h["x-slack-request-timestamp"]!, signature: h["x-slack-signature"]!, nowMs: 1_700_000_000_000 }),
  ).toEqual({ ok: false, reason: "mismatch" });
});

test("messageEnvelope carries the fields the gateway routes on", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "<@U0BOT> hi" });
  const env = messageEnvelope(ws, app, m, { eventId: "Ev0TEST" }) as any;
  expect(env).toMatchObject({
    type: "event_callback",
    api_app_id: "A0FAKE",
    team_id: "T0FAKE",
    event_id: "Ev0TEST",
    event: { type: "message", channel: "C0TEAM", channel_type: "channel", user: "U0MGR", text: "<@U0BOT> hi", ts: m.ts, team: "T0FAKE" },
    authorizations: [{ team_id: "T0FAKE", user_id: "U0BOT", is_bot: true }],
  });
  expect(env.event.thread_ts).toBeUndefined();
  expect(typeof env.event_time).toBe("number");
});

test("messageEnvelope marks DMs as im and threads replies; event ids are unique by default", () => {
  const root = ws.post({ channel: "D0MGR", user: "U0MGR", text: "dm" });
  const reply = ws.post({ channel: "D0MGR", user: "U0MGR", text: "again", threadTs: root.ts });
  const a = messageEnvelope(ws, app, root) as any;
  const b = messageEnvelope(ws, app, reply) as any;
  expect(a.event.channel_type).toBe("im");
  expect(b.event.thread_ts).toBe(root.ts);
  expect(a.event_id).not.toBe(b.event_id);
});

test("blockActionsPayload has what the approval handler reads, and is form-encodable", () => {
  const p = blockActionsPayload({
    ws,
    app,
    user: "U0MGR",
    channel: "C0TEAM",
    messageTs: "1700000000.000001",
    actionId: "slaude_appr:approve:abc",
    responseUrl: "http://fake-slack:8080/response/r1",
  }) as any;
  expect(p).toMatchObject({
    type: "block_actions",
    api_app_id: "A0FAKE",
    team: { id: "T0FAKE" },
    user: { id: "U0MGR", team_id: "T0FAKE" },
    channel: { id: "C0TEAM" },
    container: { type: "message", message_ts: "1700000000.000001", channel_id: "C0TEAM" },
    response_url: "http://fake-slack:8080/response/r1",
    actions: [{ type: "button", action_id: "slaude_appr:approve:abc" }],
  });
});

function recorder(statuses: Array<number | "hang" | "throw">) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const s = statuses[Math.min(i++, statuses.length - 1)]!;
    if (s === "throw") throw new Error("connection refused");
    if (s === "hang") {
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    return new Response("", { status: s });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const noSleep = async () => {};

test("deliverEvent: a 2xx on the first try is one attempt with no retry headers", async () => {
  const r = recorder([200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep });
  expect(res).toEqual({ attempts: [{ retryNum: 0, status: 200 }], finalStatus: 200 });
  expect(r.calls[0]!.headers["x-slack-retry-num"]).toBeUndefined();
  expect(r.calls[0]!.body).toBe('{"a":1}');
});

test("deliverEvent: a 500 then a 200 retries once, with Slack's retry headers and a fresh signature", async () => {
  const r = recorder([500, 200]);
  const stamps = [1_700_000_000_000, 1_700_000_001_000];
  let n = 0;
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0, 0, 0], nowMs: () => stamps[Math.min(n++, 1)]! });
  expect(res.attempts.map((a) => [a.retryNum, a.status])).toEqual([[0, 500], [1, 200]]);
  expect(r.calls[1]!.headers["x-slack-retry-num"]).toBe("1");
  expect(r.calls[1]!.headers["x-slack-retry-reason"]).toBe("http_error");
  expect(r.calls[1]!.headers["x-slack-request-timestamp"]).not.toBe(r.calls[0]!.headers["x-slack-request-timestamp"]);
  // every attempt sends the SAME raw body bytes that were signed
  expect(r.calls[1]!.body).toBe(r.calls[0]!.body);
});

test("deliverEvent: gives up after the configured retries, reporting the last status", async () => {
  const r = recorder([503]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0, 0, 0] });
  expect(res.attempts).toHaveLength(4);
  expect(res.finalStatus).toBe(503);
});

test("deliverEvent: a slow acknowledgement is a timeout and retries as http_timeout", async () => {
  const r = recorder(["hang", 200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, ackTimeoutMs: 20, retryDelaysMs: [0] });
  expect(res.attempts.map((a) => [a.retryNum, a.status])).toEqual([[0, "timeout"], [1, 200]]);
  expect(r.calls[1]!.headers["x-slack-retry-reason"]).toBe("http_timeout");
});

test("deliverEvent: a connection error is an error attempt and retries", async () => {
  const r = recorder(["throw", 200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0] });
  expect(res.attempts.map((a) => a.status)).toEqual(["error", 200]);
});

test("deliverEvent: retryNum option marks a single delivery as a retry (for dedup tests)", async () => {
  const r = recorder([200]);
  await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryNum: 2 });
  expect(r.calls[0]!.headers["x-slack-retry-num"]).toBe("2");
});

test("deliverInteraction posts payload=<json> form-encoded, signed over the raw form body, without retrying", async () => {
  const r = recorder([500]);
  const payload = { type: "block_actions", actions: [{ action_id: "x" }] };
  const res = await deliverInteraction("http://gw/slack/interactions", "sekret", payload, { fetchFn: r.fetchFn, sleep: noSleep });
  expect(res.attempts).toHaveLength(1);
  expect(r.calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(JSON.parse(new URLSearchParams(r.calls[0]!.body).get("payload")!)).toEqual(payload);
  expect(
    verifySlackSignature({
      signingSecret: "sekret",
      rawBody: r.calls[0]!.body,
      timestamp: r.calls[0]!.headers["x-slack-request-timestamp"]!,
      signature: r.calls[0]!.headers["x-slack-signature"]!,
    }),
  ).toEqual({ ok: true });
});
