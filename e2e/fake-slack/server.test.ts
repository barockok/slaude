import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "../../src/gateway/slack/verify";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let app: { apiAppId: string; botToken: string; signingSecret: string; botUserId: string };
let client: WebClient;

type Hit = { path: string; headers: Headers; body: string };
let receiver: ReturnType<typeof Bun.serve>;
let hits: Hit[] = [];
let receiverStatuses: number[] = [];

beforeAll(async () => {
  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 200 });
  ctl = createControlClient(fake.url);
  await ctl.addUser({ id: "U0MGR", name: "manager" });
  app = await ctl.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  await ctl.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  await ctl.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
  client = new WebClient(app.botToken, { slackApiUrl: `${fake.url}/api/`, retryConfig: { retries: 0 } });
  receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.text() });
      return new Response("", { status: receiverStatuses.shift() ?? 200 });
    },
  });
});

afterAll(async () => {
  receiver.stop(true);
  await fake.stop();
});

beforeEach(async () => {
  hits = [];
  receiverStatuses = [];
  await ctl.reset();
});

const target = () => `http://127.0.0.1:${receiver.port}`;

test("healthz", async () => {
  expect(await (await fetch(`${fake.url}/healthz`)).text()).toBe("ok");
});

test("the real @slack/web-api client works against the fake", async () => {
  const auth = await client.auth.test();
  expect(auth).toMatchObject({ ok: true, user_id: "U0BOT", team_id: "T0FAKE" });
  const posted = await client.chat.postMessage({ channel: "C0TEAM", text: "hello", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] });
  expect(posted.ok).toBe(true);
  const upd = await client.chat.update({ channel: "C0TEAM", ts: posted.ts!, text: "edited" });
  expect(upd.ok).toBe(true);
  await client.reactions.add({ channel: "C0TEAM", timestamp: posted.ts!, name: "eyes" });
  const replies = await client.conversations.replies({ channel: "C0TEAM", ts: posted.ts! });
  expect(replies.messages!.map((m) => m.text)).toEqual(["edited"]);
  const thread = await ctl.thread("C0TEAM", posted.ts!);
  expect(thread.messages[0]).toMatchObject({ text: "edited", user: "U0BOT" });
});

test("POST apps keeps supplied credentials, so re-adding an app leaves it unchanged", async () => {
  const own = await startFakeSlack({ port: 0 });
  try {
    const c = createControlClient(own.url);
    const creds = { apiAppId: "A0STABLE", name: "stable", botUserId: "U0BSTABLE", botToken: `${"xoxb"}-fake-stable`, signingSecret: "stable-secret" };
    const first = await c.addApp(creds);
    const again = await c.addApp(creds);
    expect(again).toEqual(first);
    expect(first).toMatchObject(creds);
    const fresh = await c.addApp({ apiAppId: "A0STABLE", name: "stable" });
    expect(fresh.botToken).not.toBe(creds.botToken);
    expect(fresh.signingSecret).not.toBe(creds.signingSecret);
  } finally {
    await own.stop();
  }
});

test("a Slack platform error surfaces as the SDK's platform error", async () => {
  await expect(client.chat.postMessage({ channel: "C0NOPE", text: "x" })).rejects.toMatchObject({ data: { error: "channel_not_found" } });
});

test("an unknown method is unknown_method on the wire and flagged in the call log", async () => {
  await expect(client.apiCall("nonsense.method", {})).rejects.toMatchObject({ data: { error: "unknown_method" } });
  const { calls } = await ctl.calls({ method: "nonsense.method" });
  expect(calls[0]).toMatchObject({ unknown: true, ok: false });
});

test("the call log is ordered, filterable by method and by since, and clearable", async () => {
  await client.auth.test();
  await client.chat.postMessage({ channel: "C0TEAM", text: "a" });
  const all = (await ctl.calls()).calls;
  expect(all.map((c) => c.method)).toEqual(["auth.test", "chat.postMessage"]);
  expect((await ctl.calls({ method: "chat.postMessage" })).calls).toHaveLength(1);
  expect((await ctl.calls({ since: all[0]!.seq })).calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
  await ctl.clearCalls();
  expect((await ctl.calls()).calls).toEqual([]);
});

test("faults: a 429 with Retry-After on the wire, then recovery", async () => {
  await ctl.addFault({ method: "chat.postMessage", status: 429, retryAfterSec: 7, times: 1 });
  const r = await fetch(`${fake.url}/api/chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C0TEAM", text: "x" }),
  });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("7");
  expect((await client.chat.postMessage({ channel: "C0TEAM", text: "x" })).ok).toBe(true);
  await ctl.addFault({ method: "*", status: 503, times: 5 });
  await ctl.clearFaults();
  expect((await client.auth.test()).ok).toBe(true);
});

test("send posts the human message and delivers a signed event to the target", async () => {
  const res = await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0MGR", text: "deploy", target: target(), mention: true });
  expect(res.deliveries).toHaveLength(1);
  expect(res.deliveries[0]!.finalStatus).toBe(200);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.path).toBe("/slack/events");
  const body = JSON.parse(hits[0]!.body);
  expect(body).toMatchObject({ type: "event_callback", api_app_id: "A0FAKE", event: { text: "<@U0BOT> deploy", user: "U0MGR", channel: "C0TEAM", ts: res.message.ts } });
  expect(
    verifySlackSignature({
      signingSecret: app.signingSecret,
      rawBody: hits[0]!.body,
      timestamp: hits[0]!.headers.get("x-slack-request-timestamp"),
      signature: hits[0]!.headers.get("x-slack-signature"),
    }),
  ).toEqual({ ok: true });
  expect((await ctl.messages("C0TEAM")).messages.map((m) => m.text)).toEqual(["<@U0BOT> deploy"]);
});

test("send with duplicate delivers the same event_id twice", async () => {
  await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "once", target: target(), duplicate: true });
  expect(hits).toHaveLength(2);
  expect(JSON.parse(hits[0]!.body).event_id).toBe(JSON.parse(hits[1]!.body).event_id);
});

test("send retries on a failing target like Slack does, and reports every attempt", async () => {
  receiverStatuses = [500, 500, 200];
  const res = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "flaky", target: target() });
  expect(res.deliveries[0]!.attempts.map((a) => a.status)).toEqual([500, 500, 200]);
  expect(hits.map((h) => h.headers.get("x-slack-retry-num"))).toEqual([null, "1", "2"]);
});

test("send with redeliverTs re-delivers the stored message under a new event id without posting", async () => {
  const first = await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0MGR", text: "again", target: target(), mention: true, eventId: "Ev0ONE" });
  const again = await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0MGR", target: target(), redeliverTs: first.message.ts, eventId: "Ev0TWO" });
  expect(again.message).toEqual(first.message);
  expect((await ctl.messages("C0TEAM")).messages.map((m) => m.text)).toEqual(["<@U0BOT> again"]);
  const [a, b] = hits.map((h) => JSON.parse(h.body));
  expect([a.event_id, b.event_id]).toEqual(["Ev0ONE", "Ev0TWO"]);
  expect(b.event).toEqual(a.event);
});

test("send with redeliverTs rejects a missing message, a different author and fields of a new message", async () => {
  const first = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "root", target: target() });
  const base = { app: "A0FAKE", channel: "D0MGR", user: "U0MGR", target: target() };
  hits = [];
  await expect(ctl.send({ ...base, redeliverTs: "1.000001" })).rejects.toThrow(/404 message_not_found/);
  await expect(ctl.send({ ...base, user: "U0ALICE", redeliverTs: first.message.ts })).rejects.toThrow(/400 invalid_arguments: user/);
  for (const extra of [{ text: "x" }, { threadTs: first.message.ts }, { mention: true }]) {
    const res = await fetch(`${fake.url}/__fake/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, redeliverTs: first.message.ts, ...extra }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(`invalid_arguments: ${Object.keys(extra)[0]}`);
  }
  await expect(ctl.send({ ...base, redeliverTs: 5 } as any)).rejects.toThrow(/400 invalid_arguments: redeliverTs/);
  // without redeliverTs, text stays required
  await expect(ctl.send({ ...base } as any)).rejects.toThrow(/400 invalid_arguments: text/);
  expect(hits).toEqual([]);
});

test("send honours threadTs and an unknown app or channel is a clear 4xx", async () => {
  const root = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "root", target: target() });
  const child = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "child", target: target(), threadTs: root.message.ts });
  expect(JSON.parse(hits[1]!.body).event.thread_ts).toBe(root.message.ts);
  expect(child.message.threadTs).toBe(root.message.ts);
  await expect(ctl.send({ app: "A0NOPE", channel: "D0MGR", user: "U0MGR", text: "x", target: target() })).rejects.toThrow(/unknown app/);
  await expect(ctl.send({ app: "A0FAKE", channel: "C0NOPE", user: "U0MGR", text: "x", target: target() })).rejects.toThrow(/channel_not_found/);
});

test("click delivers a signed interaction with a response_url the fake serves", async () => {
  const card = await client.chat.postMessage({ channel: "C0TEAM", text: "card", blocks: [] });
  const res = await ctl.click({ app: "A0FAKE", target: target(), user: "U0MGR", channel: "C0TEAM", messageTs: card.ts!, actionId: "slaude_appr:approve:abc" });
  expect(res.delivery.finalStatus).toBe(200);
  expect(hits[0]!.path).toBe("/slack/interactions");
  const payload = JSON.parse(new URLSearchParams(hits[0]!.body).get("payload")!);
  expect(payload.actions[0].action_id).toBe("slaude_appr:approve:abc");
  expect(payload.response_url).toStartWith(`${fake.url}/response/`);
  // the gateway would answer by POSTing to response_url
  const answered = await fetch(payload.response_url, { method: "POST", body: JSON.stringify({ text: "done", replace_original: true }) });
  expect(await answered.text()).toBe("ok");
  const rows = (await ctl.calls({ method: "response_url" })).calls;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "response_url", ok: true });
  expect(rows[0]!.detail).toMatchObject({ body: { text: "done" } });
});

test("a response_url answer is applied to the clicked message the way Slack does", async () => {
  const urlFor = async (messageTs: string) => {
    hits = [];
    await ctl.click({ app: "A0FAKE", target: target(), user: "U0MGR", channel: "C0TEAM", messageTs, actionId: "a" });
    return JSON.parse(new URLSearchParams(hits[0]!.body).get("payload")!).response_url as string;
  };
  const answer = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const card = await client.chat.postMessage({ channel: "C0TEAM", text: "card", blocks: [{ type: "actions", elements: [] }] });

  // replace_original rewrites the clicked message in place (no blocks in the answer: none left)
  await answer(await urlFor(card.ts!), { replace_original: true, text: "decided" });
  expect((await ctl.messages("C0TEAM")).messages).toMatchObject([{ ts: card.ts, text: "decided", blocks: [] }]);
  // an ephemeral answer (the default) reaches only the clicker and leaves the message alone
  await answer(await urlFor(card.ts!), { response_type: "ephemeral", replace_original: false, text: "only you" });
  await answer(await urlFor(card.ts!), { text: "also only you" });
  expect(fake.ws.ephemerals().filter((e) => e.text.includes("only you")).map((e) => [e.channel, e.user, e.text])).toEqual([
    ["C0TEAM", "U0MGR", "only you"],
    ["C0TEAM", "U0MGR", "also only you"],
  ]);
  // in_channel posts a new message as the app's bot
  await answer(await urlFor(card.ts!), { response_type: "in_channel", text: "for everyone" });
  expect((await ctl.messages("C0TEAM")).messages.map((m) => [m.user, m.text])).toEqual([
    ["U0BOT", "decided"],
    ["U0BOT", "for everyone"],
  ]);
  // delete_original removes it
  await answer(await urlFor(card.ts!), { delete_original: true });
  expect((await ctl.messages("C0TEAM")).messages.map((m) => m.text)).toEqual(["for everyone"]);
  // every answer is logged with where it was applied
  const rows = (await ctl.calls({ method: "response_url" })).calls;
  expect(rows.map((r) => r.detail?.applied)).toEqual(["replace_original", "ephemeral", "ephemeral", "in_channel", "delete_original"]);
  expect(rows[0]!.detail).toMatchObject({ channel: "C0TEAM", messageTs: card.ts, user: "U0MGR" });
  // answering for a message that is gone is an error, like Slack's
  const gone = await answer(await urlFor(card.ts!), { replace_original: true, text: "late" });
  expect(gone.status).toBe(404);
  expect((await ctl.calls({ method: "response_url" })).calls.at(-1)).toMatchObject({ ok: false, error: "message_not_found" });
  // reset forgets issued response_urls: a later answer is only recorded
  const stale = await urlFor(card.ts!);
  await ctl.reset();
  expect((await answer(stale, { replace_original: true, text: "after reset" })).status).toBe(200);
  expect((await ctl.calls({ method: "response_url" })).calls[0]!.detail?.applied).toBeUndefined();
});

test("reset clears messages, calls and faults but keeps users, apps and channels", async () => {
  await client.chat.postMessage({ channel: "C0TEAM", text: "gone soon" });
  await ctl.addFault({ method: "*", status: 500, times: 9 });
  await ctl.reset();
  expect((await ctl.messages("C0TEAM")).messages).toEqual([]);
  expect((await ctl.calls()).calls).toEqual([]);
  expect((await client.auth.test()).ok).toBe(true);
});

test("response_url is built from publicUrl, not the listen address", async () => {
  const other = await startFakeSlack({ port: 0, publicUrl: "http://fake-slack.cluster.local:8080/", retryDelaysMs: [0], ackTimeoutMs: 200 });
  try {
    const c2 = createControlClient(other.url);
    await c2.addUser({ id: "U0MGR", name: "manager" });
    await c2.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
    await c2.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR"] });
    const card = other.ws.post({ channel: "C0TEAM", user: "U0BOT", text: "card" });
    await c2.click({ app: "A0FAKE", target: target(), user: "U0MGR", channel: "C0TEAM", messageTs: card.ts, actionId: "a" });
    const payload = JSON.parse(new URLSearchParams(hits[0]!.body).get("payload")!);
    expect(payload.response_url).toStartWith("http://fake-slack.cluster.local:8080/response/");
  } finally {
    await other.stop();
  }
});

test("control: apps are listed, a missing thread is a 4xx, and the client reports the status of any failure body", async () => {
  const listed = (await (await fetch(`${fake.url}/__fake/apps`)).json()) as { apps: { apiAppId: string }[] };
  expect(listed.apps.map((a) => a.apiAppId)).toEqual(["A0FAKE"]);
  expect((await ctl.apps()).apps.map((a) => [a.apiAppId, a.botUserId])).toEqual([["A0FAKE", "U0BOT"]]);
  await expect(ctl.thread("C0TEAM", "1.1")).rejects.toThrow(/400 thread_not_found/);
  receiverStatuses = [500];
  await expect(createControlClient(target()).reset()).rejects.toThrow(/^500 $/);
  const odd = Bun.serve({ port: 0, fetch: () => new Response("<html>bad gateway</html>", { status: 502 }) });
  try {
    await expect(createControlClient(`http://127.0.0.1:${odd.port}`).reset()).rejects.toThrow(/502 <html>bad gateway/);
  } finally {
    odd.stop(true);
  }
});

test("reset removes every message including a thread root's replies", async () => {
  const root = await client.chat.postMessage({ channel: "C0TEAM", text: "root" });
  await client.chat.postMessage({ channel: "C0TEAM", text: "reply", thread_ts: root.ts! });
  await client.chat.delete({ channel: "C0TEAM", ts: root.ts! });
  await ctl.reset();
  expect((await ctl.messages("C0TEAM")).messages).toEqual([]);
});

test("a response_url body that is not JSON is recorded as text", async () => {
  const r = await fetch(`${fake.url}/response/abc`, { method: "POST", body: "plain" });
  expect(await r.text()).toBe("ok");
  expect((await ctl.calls({ method: "response_url" })).calls[0]!.detail).toMatchObject({ id: "abc", body: "plain" });
});

test("hostile requests get specific statuses, never crash the server, and have no side effects", async () => {
  const json = { "content-type": "application/json" };
  const post = (path: string, body: string) => fetch(`${fake.url}${path}`, { method: "POST", headers: json, body });
  const bearer = { ...json, authorization: `Bearer ${app.botToken}` };
  const base = { app: "A0FAKE", channel: "C0TEAM", user: "U0MGR", text: "hi", target: target() };
  const clickBase = { app: "A0FAKE", target: target(), user: "U0MGR", channel: "C0TEAM", messageTs: "1.1", actionId: "a" };

  const bad = async (path: string, body: string, status: number, error: string) => {
    const res = await post(path, body);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, error });
  };

  // control routes
  await bad("/__fake/send", "not json", 400, "body is not JSON");
  await bad("/__fake/send", "null", 400, "invalid_arguments: body");
  await bad("/__fake/send", "[1]", 400, "invalid_arguments: body");
  await bad("/__fake/send", "5", 400, "invalid_arguments: body");
  const { target: _t, ...noTarget } = base;
  await bad("/__fake/send", JSON.stringify(noTarget), 400, "invalid_arguments: target");
  await bad("/__fake/send", JSON.stringify({ ...base, target: "not a url" }), 400, "invalid_arguments: target");
  await bad("/__fake/send", JSON.stringify({ ...base, target: "ftp://127.0.0.1" }), 400, "invalid_arguments: target");
  await bad("/__fake/send", JSON.stringify({ ...base, text: 5 }), 400, "invalid_arguments: text");
  await bad("/__fake/send", JSON.stringify({ ...base, mention: "yes" }), 400, "invalid_arguments: mention");
  await bad("/__fake/send", JSON.stringify({ ...base, retryNum: -1 }), 400, "invalid_arguments: retryNum");
  await bad("/__fake/send", JSON.stringify({ ...base, retryDelaysMs: [-1] }), 400, "invalid_arguments: retryDelaysMs");
  await bad("/__fake/send", JSON.stringify({ ...base, retryDelaysMs: new Array(11).fill(0) }), 400, "invalid_arguments: retryDelaysMs");
  await bad("/__fake/send", JSON.stringify({ ...base, ackTimeoutMs: 0 }), 400, "invalid_arguments: ackTimeoutMs");
  const { actionId: _a, ...noAction } = clickBase;
  await bad("/__fake/click", JSON.stringify(noAction), 400, "invalid_arguments: actionId");
  await bad("/__fake/click", JSON.stringify({ ...clickBase, value: 1 }), 400, "invalid_arguments: value");
  await bad("/__fake/send", JSON.stringify({ ...base, app: "A0NOPE" }), 404, "unknown app A0NOPE");
  await bad("/__fake/send", JSON.stringify({ ...base, channel: "C0NOPE" }), 404, "channel_not_found");
  expect((await fetch(`${fake.url}/__fake/nope`)).status).toBe(404);
  expect((await fetch(`${fake.url}/nope`)).status).toBe(404);

  // nothing was posted or delivered by any rejected request
  expect((await ctl.messages("C0TEAM")).messages).toEqual([]);
  expect(hits).toEqual([]);

  // the Web API answers errors with 200 and an ok:false body, like Slack
  const garbled = await fetch(`${fake.url}/api/chat.postMessage`, { method: "POST", body: "{{{{", headers: bearer });
  expect(garbled.status).toBe(200);
  expect(await garbled.json()).toMatchObject({ ok: false });
  const empty = await fetch(`${fake.url}/api/`, { method: "POST", body: "" });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ ok: false, error: expect.any(String) });

  expect(await (await fetch(`${fake.url}/healthz`)).text()).toBe("ok");
});

test("send accepts a trailing slash on the target", async () => {
  await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "slash", target: `${target()}/` });
  expect(hits[0]!.path).toBe("/slack/events");
});

test("per-request retryDelaysMs and ackTimeoutMs override the server defaults", async () => {
  const slow = await startFakeSlack({ port: 0, retryDelaysMs: [60_000, 60_000, 60_000], ackTimeoutMs: 200 });
  try {
    const c2 = createControlClient(slow.url);
    await c2.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
    await c2.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR"] });
    receiverStatuses = [500, 500, 500];
    const t0 = Date.now();
    const res = await c2.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "x", target: target(), retryDelaysMs: [0], ackTimeoutMs: 100 });
    expect(res.deliveries[0]!.attempts.map((a) => a.status)).toEqual([500, 500]);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const card = slow.ws.post({ channel: "D0MGR", user: "U0BOT", text: "card" });
    receiverStatuses = [];
    // interactions are not retried; the overrides are accepted and applied without error
    const click = await c2.click({ app: "A0FAKE", target: target(), user: "U0MGR", channel: "D0MGR", messageTs: card.ts, actionId: "a", retryDelaysMs: [0], ackTimeoutMs: 100 });
    expect(click.delivery.finalStatus).toBe(200);
  } finally {
    await slow.stop();
  }
});

test("until polls to a truthy value and times out with the given description", async () => {
  let n = 0;
  expect(await until(() => (++n > 2 ? "ready" : null), { intervalMs: 5, timeoutMs: 500 })).toBe("ready");
  await expect(until(() => false, { intervalMs: 5, timeoutMs: 30, what: "the impossible" })).rejects.toThrow(/the impossible/);
  await expect(until(() => 0, { intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/waiting for condition/);
});
