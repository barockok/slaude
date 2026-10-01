import { expect, test } from "bun:test";
import { createSchemaGuard } from "./schema-guard";

const guard = createSchemaGuard({
  "chat.postMessage": { params: ["channel", "text", "thread_ts", "blocks"], required: ["channel"], response: ["ok", "channel", "ts", "message", "error"] },
});

test("a valid request is clean", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", text: "x" })).toEqual([]);
});
test("an unknown parameter name is a violation", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", txt: "x" })).toEqual(['chat.postMessage: unknown parameter "txt"']);
});
test("a missing required parameter is a violation", () => {
  expect(guard.checkRequest("chat.postMessage", { text: "x" })).toEqual(['chat.postMessage: missing required parameter "channel"']);
});
test("the token parameter is always allowed", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", token: "t" })).toEqual([]);
});
test("an unknown response property is a violation", () => {
  expect(guard.checkResponse("chat.postMessage", { ok: true, ts: "1", bogus: 1 })).toEqual(['chat.postMessage: unknown response property "bogus"']);
});
test("ok and error are always allowed in a response", () => {
  expect(guard.checkResponse("chat.postMessage", { ok: false, error: "channel_not_found" })).toEqual([]);
});
test("methods without a schema are not judged", () => {
  expect(guard.checkRequest("assistant.threads.setStatus", { anything: 1 })).toEqual([]);
  expect(guard.checkResponse("assistant.threads.setStatus", { ok: true, anything: 1 })).toEqual([]);
});
test("a method named like an Object.prototype member is not judged", () => {
  expect(guard.checkRequest("constructor", { anything: 1 })).toEqual([]);
});
