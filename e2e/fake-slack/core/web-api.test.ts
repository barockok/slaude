import { beforeEach, expect, test } from "bun:test";
import { CallLog } from "./call-log";
import { createSchemaGuard } from "./schema-guard";
import { FaultStore, KNOWN_METHODS, createWebApi, parseParams } from "./web-api";
import { Workspace } from "./workspace";

let ws: Workspace;
let log: CallLog;
let faults: FaultStore;
let api: ReturnType<typeof createWebApi>;
let token: string;

beforeEach(() => {
  ws = new Workspace("T0FAKE");
  const app = ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  token = app.botToken;
  ws.addUser("U0MGR", "manager");
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  log = new CallLog();
  faults = new FaultStore();
  api = createWebApi(ws, log, faults);
});

const call = (method: string, params: Record<string, unknown> = {}, bearer: string | null = token) => api(method, params, bearer);

test("parseParams reads form bodies, JSON bodies, and JSON-encodes nothing twice", () => {
  const form = parseParams("application/x-www-form-urlencoded", "channel=C1&text=hi&blocks=%5B%7B%22type%22%3A%22divider%22%7D%5D");
  expect(form).toEqual({ channel: "C1", text: "hi", blocks: [{ type: "divider" }] });
  const json = parseParams("application/json; charset=utf-8", JSON.stringify({ channel: "C1", blocks: [{ type: "divider" }] }));
  expect(json).toEqual({ channel: "C1", blocks: [{ type: "divider" }] });
  expect(parseParams(null, "")).toEqual({});
  expect(parseParams("application/json", "not json")).toEqual({});
  expect(parseParams("application/x-www-form-urlencoded", "blocks=not-json").blocks).toBe("not-json");
});

test("auth.test identifies the bot for the token", () => {
  const r = call("auth.test");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, user_id: "U0BOT", team_id: "T0FAKE", bot_id: expect.any(String) });
});

test("a bad or missing token is invalid_auth", () => {
  expect(call("auth.test", {}, "nope").body).toEqual({ ok: false, error: "invalid_auth" });
  expect(call("chat.postMessage", { channel: "C0TEAM", text: "x" }, null).body).toEqual({ ok: false, error: "invalid_auth" });
});

test("the token can come from the token param when there is no bearer", () => {
  expect(call("auth.test", { token }, null).body).toMatchObject({ ok: true });
});

test("chat.postMessage posts as the bot, supports threads and blocks", () => {
  const root = call("chat.postMessage", { channel: "C0TEAM", text: "hello" }).body as any;
  expect(root.ok).toBe(true);
  expect(root.channel).toBe("C0TEAM");
  expect(typeof root.ts).toBe("string");
  expect(root.message.user).toBe("U0BOT");
  expect(root.message.text).toBe("hello");
  const rootTs = root.ts as string;
  const reply = call("chat.postMessage", { channel: "C0TEAM", text: "re", thread_ts: rootTs, blocks: [{ type: "divider" }] }).body as any;
  expect(reply.message.thread_ts).toBe(rootTs);
  expect(ws.replies("C0TEAM", rootTs).map((m) => m.text)).toEqual(["hello", "re"]);
  expect((ws.message("C0TEAM", reply.ts)!.blocks as unknown[]).length).toBe(1);
});

test("chat.postMessage errors are Slack errors in an HTTP 200", () => {
  expect(call("chat.postMessage", { channel: "C0NOPE", text: "x" })).toMatchObject({ status: 200, body: { ok: false, error: "channel_not_found" } });
  expect(call("chat.postMessage", { text: "x" }).body).toEqual({ ok: false, error: "channel_not_found" });
  expect(call("chat.postMessage", { channel: "C0TEAM" }).body).toEqual({ ok: false, error: "no_text" });
});

test("chat.update, chat.delete, reactions, pins", () => {
  const ts = (call("chat.postMessage", { channel: "C0TEAM", text: "v1" }).body as any).ts as string;
  expect(call("chat.update", { channel: "C0TEAM", ts, text: "v2" }).body).toMatchObject({ ok: true, text: "v2" });
  expect(call("reactions.add", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: true });
  expect(call("reactions.add", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: false, error: "already_reacted" });
  expect(call("reactions.remove", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: true });
  expect(call("pins.add", { channel: "C0TEAM", timestamp: ts }).body).toEqual({ ok: true });
  expect(call("pins.remove", { channel: "C0TEAM", timestamp: ts }).body).toEqual({ ok: true });
  expect(call("chat.delete", { channel: "C0TEAM", ts }).body).toMatchObject({ ok: true, ts });
  expect(call("chat.update", { channel: "C0TEAM", ts, text: "v3" }).body).toEqual({ ok: false, error: "message_not_found" });
});

test("chat.postEphemeral does not enter the channel's messages", () => {
  const r = call("chat.postEphemeral", { channel: "C0TEAM", user: "U0MGR", text: "psst" }).body as any;
  expect(r).toMatchObject({ ok: true, message_ts: expect.any(String) });
  expect(ws.messages("C0TEAM")).toHaveLength(0);
  expect(ws.ephemerals()).toHaveLength(1);
});

test("users.info and conversations.* read the workspace", () => {
  expect(call("users.info", { user: "U0MGR" }).body).toMatchObject({ ok: true, user: { id: "U0MGR", name: "manager", is_bot: false } });
  expect(call("users.info", { user: "U0NOPE" }).body).toEqual({ ok: false, error: "user_not_found" });
  expect(call("conversations.info", { channel: "C0TEAM" }).body).toMatchObject({ ok: true, channel: { id: "C0TEAM", name: "team", is_im: false } });
  expect(call("conversations.members", { channel: "C0TEAM" }).body).toMatchObject({ ok: true, members: ["U0MGR", "U0BOT"] });
  expect(call("conversations.setTopic", { channel: "C0TEAM", topic: "t" }).body).toMatchObject({ ok: true });
  expect(call("conversations.setPurpose", { channel: "C0TEAM", purpose: "p" }).body).toMatchObject({ ok: true });
  expect(ws.channels.get("C0TEAM")).toMatchObject({ topic: "t", purpose: "p" });
});

test("conversations.replies returns the thread", () => {
  const root = (call("chat.postMessage", { channel: "C0TEAM", text: "root" }).body as any).ts as string;
  call("chat.postMessage", { channel: "C0TEAM", text: "child", thread_ts: root });
  const r = call("conversations.replies", { channel: "C0TEAM", ts: root }).body as any;
  expect(r.ok).toBe(true);
  expect(r.messages.map((m: any) => m.text)).toEqual(["root", "child"]);
  expect(call("conversations.replies", { channel: "C0TEAM", ts: "1.000001" }).body).toEqual({ ok: false, error: "thread_not_found" });
});

test("search.messages, files.info, assistant.threads.setStatus, users.profile.set", () => {
  call("chat.postMessage", { channel: "C0TEAM", text: "needle in a haystack" });
  const s = call("search.messages", { query: "needle" }).body as any;
  expect(s.ok).toBe(true);
  expect(s.messages.total).toBe(1);
  expect(s.messages.matches[0].text).toBe("needle in a haystack");
  expect(call("files.info", { file: "F0NOPE" }).body).toEqual({ ok: false, error: "file_not_found" });
  expect(call("assistant.threads.setStatus", { channel_id: "C0TEAM", thread_ts: "1.000001", status: "thinking" }).body).toEqual({ ok: true });
  expect(call("users.profile.set", { profile: "{}" }).body).toEqual({ ok: true });
});

test("an unknown method fails loudly, is flagged in the log, and never succeeds", () => {
  const r = call("nonsense.method", { a: 1 });
  expect(r).toMatchObject({ status: 200, body: { ok: false, error: "unknown_method" } });
  const row = log.all().at(-1)!;
  expect(row).toMatchObject({ kind: "api", method: "nonsense.method", ok: false, error: "unknown_method", unknown: true });
});

test("every call is logged with the token redacted, app attributed, and ok/error recorded", () => {
  call("chat.postMessage", { channel: "C0TEAM", text: "logged", token: "secret" });
  call("chat.postMessage", { channel: "C0NOPE", text: "bad" });
  const [a, b] = log.all();
  expect(a).toMatchObject({ method: "chat.postMessage", app: "A0FAKE", ok: true, status: 200 });
  expect(a!.args).toEqual({ channel: "C0TEAM", text: "logged" });
  expect(b).toMatchObject({ ok: false, error: "channel_not_found" });
});

test("fault rules return 429 with Retry-After or a 5xx, then expire", () => {
  faults.add({ method: "chat.postMessage", status: 429, retryAfterSec: 3, times: 1 });
  const limited = call("chat.postMessage", { channel: "C0TEAM", text: "x" });
  expect(limited.status).toBe(429);
  expect(limited.headers).toEqual({ "retry-after": "3" });
  expect(limited.body).toEqual({ ok: false, error: "ratelimited" });
  expect(call("chat.postMessage", { channel: "C0TEAM", text: "x" }).status).toBe(200);
  expect(ws.messages("C0TEAM")).toHaveLength(1); // the faulted call had no effect

  faults.add({ method: "*", status: 503, times: 2 });
  expect(call("auth.test").status).toBe(503);
  expect(call("users.info", { user: "U0MGR" }).status).toBe(503);
  expect(call("auth.test").status).toBe(200);
  expect(log.where((r) => r.status === 429 || r.status === 503)).toHaveLength(3);
});

test("FaultStore.clear removes pending rules", () => {
  faults.add({ method: "*", status: 500, times: 5 });
  faults.clear();
  expect(faults.consume("auth.test")).toBeUndefined();
});

test("KNOWN_METHODS lists exactly what the dispatcher implements", () => {
  for (const m of KNOWN_METHODS) expect(call(m, {}).body.error).not.toBe("unknown_method");
});

test("inherited properties like constructor do not resolve as handlers", () => {
  const prototypeNames = ["constructor", "toString", "hasOwnProperty", "__proto__"];
  for (const name of prototypeNames) {
    const r = call(name as any, { ok: true });
    expect(r).toMatchObject({ status: 200, body: { ok: false, error: "unknown_method" } });
    const row = log.all().at(-1)!;
    expect(row).toMatchObject({ method: name, ok: false, error: "unknown_method", unknown: true });
  }
});

test("non-SlackError thrown by handler is logged as fake_internal_error with 500", () => {
  const badWs = new Workspace("T0FAKE");
  const app = badWs.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  const badLog = new CallLog();
  const badFaults = new FaultStore();

  // Create a workspace proxy that throws on search()
  const wsProxy = new Proxy(badWs, {
    get(target, prop) {
      if (prop === "search") {
        return () => {
          throw new Error("intentional test error");
        };
      }
      return Reflect.get(target, prop);
    },
  });

  const api = createWebApi(wsProxy as any, badLog, badFaults);
  const result = api("search.messages", { query: "test" }, app.botToken);

  expect(result.status).toBe(500);
  expect(result.body).toEqual({ ok: false, error: "fake_internal_error" });
  const row = badLog.all().at(-1)!;
  expect(row).toMatchObject({ method: "search.messages", ok: false, error: "fake_internal_error", status: 500 });
});

test("with a schema guard, violations are recorded in the call log and the response is unchanged", () => {
  const guarded = createWebApi(
    ws,
    log,
    faults,
    createSchemaGuard({ "chat.postMessage": { params: ["channel", "text"], required: ["channel"], response: ["ok", "channel"] } }),
  );
  const r = guarded("chat.postMessage", { channel: "C0TEAM", text: "hi", bogus: 1 }, token);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, channel: "C0TEAM", ts: expect.any(String), message: expect.any(Object) });
  expect(log.all()[0]!.schemaViolations).toEqual([
    'chat.postMessage: unknown parameter "bogus"',
    'chat.postMessage: unknown response property "ts"',
    'chat.postMessage: unknown response property "message"',
  ]);
});

test("a clean call has no schemaViolations field, with a guard or without", () => {
  const guarded = createWebApi(
    ws,
    log,
    faults,
    createSchemaGuard({ "reactions.add": { params: ["channel", "name", "timestamp"], required: [], response: ["ok"] } }),
  );
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "x" });
  guarded("reactions.add", { channel: "C0TEAM", name: "eyes", timestamp: m.ts }, token);
  call("auth.test");
  expect(log.all().map((r) => "schemaViolations" in r)).toEqual([false, false]);
});
