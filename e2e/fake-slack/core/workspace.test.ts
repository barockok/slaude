import { beforeEach, expect, test } from "bun:test";
import { SlackError, Workspace } from "./workspace";

let ws: Workspace;
beforeEach(() => {
  ws = new Workspace("T0FAKE");
  ws.addUser("U0MGR", "manager");
  ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  ws.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof SlackError ? e.code : String(e);
  }
  return "no-error";
};

test("addApp creates a bot user, a unique token and a signing secret", () => {
  const app = ws.apps.get("A0FAKE")!;
  expect(app.botUserId).toBe("U0BOT");
  expect(ws.users.get("U0BOT")!.isBot).toBe(true);
  expect(app.botToken.length).toBeGreaterThan(10);
  expect(app.signingSecret.length).toBeGreaterThanOrEqual(16);
  const other = ws.addApp({ apiAppId: "A0OTHER", name: "other" });
  expect(other.botToken).not.toBe(app.botToken);
  expect(other.botUserId).not.toBe("U0BOT");
  expect(ws.appByToken(app.botToken)).toBe(app);
  expect(ws.appByToken("nope")).toBeUndefined();
});

test("post creates messages with increasing ts; replies attach to a thread root", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "hello" });
  const reply = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "hi", threadTs: root.ts, appId: "A0FAKE" });
  expect(Number(reply.ts)).toBeGreaterThan(Number(root.ts));
  expect(reply.threadTs).toBe(root.ts);
  expect(ws.replies("C0TEAM", root.ts).map((m) => m.text)).toEqual(["hello", "hi"]);
});

test("replies of a message without a thread is just the message", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "alone" });
  expect(ws.replies("C0TEAM", root.ts)).toHaveLength(1);
});

test("unknown channel and unknown thread are Slack errors", () => {
  expect(code(() => ws.post({ channel: "C0NOPE", user: "U0MGR", text: "x" }))).toBe("channel_not_found");
  expect(code(() => ws.post({ channel: "C0TEAM", user: "U0MGR", text: "x", threadTs: "1.000001" }))).toBe("thread_not_found");
  expect(code(() => ws.replies("C0TEAM", "1.000001"))).toBe("thread_not_found");
});

test("update edits text, remove hides the message from threads", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "v1", appId: "A0FAKE" });
  const reply = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "r", threadTs: root.ts });
  expect(ws.update("C0TEAM", root.ts, { text: "v2" }).edited).toBe(true);
  expect(ws.message("C0TEAM", root.ts)!.text).toBe("v2");
  ws.remove("C0TEAM", reply.ts);
  expect(ws.replies("C0TEAM", root.ts)).toHaveLength(1);
  expect(code(() => ws.update("C0TEAM", reply.ts, { text: "x" }))).toBe("message_not_found");
  expect(code(() => ws.remove("C0TEAM", "9.000001"))).toBe("message_not_found");
});

test("reactions: add once, remove once", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "react to me" });
  ws.react("C0TEAM", m.ts, "eyes", "U0BOT");
  expect(code(() => ws.react("C0TEAM", m.ts, "eyes", "U0BOT"))).toBe("already_reacted");
  expect([...ws.message("C0TEAM", m.ts)!.reactions.get("eyes")!]).toEqual(["U0BOT"]);
  ws.unreact("C0TEAM", m.ts, "eyes", "U0BOT");
  expect(code(() => ws.unreact("C0TEAM", m.ts, "eyes", "U0BOT"))).toBe("no_reaction");
  expect(code(() => ws.react("C0TEAM", "9.000001", "eyes", "U0BOT"))).toBe("message_not_found");
});

test("pins: pin once, unpin once", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "pin me" });
  ws.pin("C0TEAM", m.ts);
  expect(code(() => ws.pin("C0TEAM", m.ts))).toBe("already_pinned");
  ws.unpin("C0TEAM", m.ts);
  expect(code(() => ws.unpin("C0TEAM", m.ts))).toBe("not_pinned");
});

test("topic, purpose, members, search and ephemerals", () => {
  ws.setTopic("C0TEAM", "the topic");
  ws.setPurpose("C0TEAM", "the purpose");
  expect(ws.channels.get("C0TEAM")!.topic).toBe("the topic");
  expect(ws.channels.get("C0TEAM")!.purpose).toBe("the purpose");
  expect(ws.members("C0TEAM")).toEqual(["U0MGR", "U0BOT"]);
  expect(code(() => ws.members("C0NOPE"))).toBe("channel_not_found");
  ws.post({ channel: "C0TEAM", user: "U0MGR", text: "Deploy the Thing" });
  expect(ws.search("deploy the").map((m) => m.text)).toEqual(["Deploy the Thing"]);
  const ts = ws.postEphemeral("C0TEAM", "U0MGR", "only you");
  expect(ws.ephemerals()).toEqual([{ channel: "C0TEAM", user: "U0MGR", text: "only you", ts }]);
});

test("messages(channel) returns post order including replies", () => {
  const a = ws.post({ channel: "D0MGR", user: "U0MGR", text: "one" });
  ws.post({ channel: "D0MGR", user: "U0BOT", text: "two", threadTs: a.ts });
  expect(ws.messages("D0MGR").map((m) => m.text)).toEqual(["one", "two"]);
});
