import { expect, test } from "bun:test";
import type { CallRecord } from "../fake-slack/core/call-log";
import {
  dmChannelId,
  journalRowsFor,
  lastSeq,
  maskSecrets,
  personaReplies,
  podUrls,
  seedCommand,
  stableCredentials,
  unknownMethods,
  type MockJournalRow,
} from "./suite-logic";

const SEED = {
  personaId: "alpha",
  apiAppId: "A0APP",
  teamId: "T0TEAM",
  botToken: "tok-1",
  signingSecret: "sec-1",
  botUserId: "U0BOT",
};

test("the seed command sets the guard through env and passes every value as its own argv entry", () => {
  expect(seedCommand(SEED)).toEqual([
    "env", "SLAUDE_E2E_SEED=1", "bun", "/tmp/seed-persona.ts",
    "--persona-id", "alpha",
    "--api-app-id", "A0APP",
    "--team-id", "T0TEAM",
    "--bot-token", "tok-1",
    "--signing-secret", "sec-1",
    "--bot-user-id", "U0BOT",
  ]);
  expect(seedCommand(SEED, "/x/seed.ts")[3]).toBe("/x/seed.ts");
  expect(() => seedCommand({ ...SEED, signingSecret: "" })).toThrow(/signingSecret is empty/);
});

test("secrets are masked wherever they appear, and empty secrets are ignored", () => {
  expect(maskSecrets("a tok-1 b sec-1 c tok-1", ["tok-1", "sec-1", ""])).toBe("a (masked) b (masked) c (masked)");
});

test("stable credentials depend only on the app id and persona, and differ between apps", () => {
  const a = stableCredentials("A0ONE", "alpha");
  expect(stableCredentials("A0ONE", "alpha")).toEqual(a);
  expect(a.botUserId).toBe("U0BALPHA");
  expect(a.botToken).toMatch(new RegExp(`^${"xoxb"}-fake-[0-9a-f]{24}$`));
  expect(a.signingSecret).toMatch(/^[0-9a-f]{32}$/);
  const b = stableCredentials("A0TWO", "alpha");
  expect(b.botToken).not.toBe(a.botToken);
  expect(b.signingSecret).not.toBe(a.signingSecret);
  expect(() => stableCredentials("A0ONE", "Alpha-1")).toThrow(/lowercase/);
});

test("DM channel ids are Slack-shaped and unique per call", () => {
  expect(dmChannelId(() => Buffer.from([0, 1, 2, 25, 26, 31, 32, 63]))).toBe("D0E2EABCZ27A7");
  const ids = new Set(Array.from({ length: 200 }, () => dmChannelId()));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(id).toMatch(/^D0E2E[A-Z2-7]{8}$/);
});

test("gateway pod URLs are sorted by pod name and skip pods without an IP", () => {
  expect(podUrls({ "gw-b": "10.0.0.2", "gw-a": "10.0.0.1", "gw-c": "" })).toEqual(["http://10.0.0.1:8080", "http://10.0.0.2:8080"]);
  expect(podUrls({ x: "10.0.0.9" }, 9000)).toEqual(["http://10.0.0.9:9000"]);
});

test("persona replies are bot messages carrying the bracketed persona label", () => {
  const msgs = [
    { user: "U0MGR", text: "[alpha] from a human" },
    { user: "U0BOT", text: "[alpha] hello" },
    { user: "U0BOT", text: "alpha without brackets" },
    { user: "U0BOT", text: "[beta] other persona" },
  ];
  expect(personaReplies(msgs, "U0BOT", "alpha")).toEqual([{ user: "U0BOT", text: "[alpha] hello" }]);
});

const call = (seq: number, method: string, unknown?: boolean): CallRecord => ({ seq, at: 0, kind: "api", method, ok: !unknown, status: 200, unknown });

test("call-log marks and unknown-method extraction", () => {
  expect(lastSeq([])).toBe(0);
  expect(lastSeq([call(3, "a"), call(7, "b"), call(5, "c")])).toBe(7);
  expect(unknownMethods([call(1, "chat.postMessage"), call(2, "views.publish", true), call(3, "x.y", true)])).toEqual(["views.publish", "x.y"]);
});

test("journal rows are filtered by tag and time", () => {
  const row = (ts: number, tag: string | null): MockJournalRow => ({ ts, method: "POST", path: "/v1/messages", retryCount: 0, tag, action: "proxy", messages: 1, historyHash: "h" });
  const rows = [row(10, "echo"), row(20, "echo"), row(30, null), row(40, "think")];
  expect(journalRowsFor(rows, "echo", 15)).toEqual([row(20, "echo")]);
  expect(journalRowsFor(rows, "echo", 10)).toHaveLength(2);
});
