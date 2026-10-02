import { expect, test } from "bun:test";
import { CallLog, redactArgs } from "./call-log";

test("assigns increasing seq numbers and supports filtering and counting", () => {
  const log = new CallLog();
  log.add({ kind: "api", method: "chat.postMessage", ok: true, status: 200 }, 10);
  log.add({ kind: "api", method: "auth.test", ok: true, status: 200 }, 11);
  log.add({ kind: "api", method: "chat.postMessage", ok: false, error: "channel_not_found", status: 200 }, 12);
  expect(log.all().map((r) => r.seq)).toEqual([1, 2, 3]);
  expect(log.count("chat.postMessage")).toBe(2);
  expect(log.where((r) => !r.ok)).toHaveLength(1);
  expect(log.all()[0]!.at).toBe(10);
});

test("clear empties the log but keeps numbering monotonic", () => {
  const log = new CallLog();
  log.add({ kind: "api", method: "a", ok: true, status: 200 });
  log.clear();
  expect(log.all()).toEqual([]);
  expect(log.add({ kind: "api", method: "b", ok: true, status: 200 }).seq).toBe(2);
});

test("redactArgs drops the token", () => {
  expect(redactArgs({ token: "t", channel: "C1", text: "hi" })).toEqual({ channel: "C1", text: "hi" });
});
