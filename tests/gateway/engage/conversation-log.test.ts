import { describe, expect, test } from "bun:test";
import { LOG_CAP, LOG_TEXT_CHARS, AGENT_BOT_ID, logKey, memoryConversationLog, redisConversationLog, toThreadMsg, type ConversationLog, type LogEntry } from "../../../src/gateway/engage/conversation-log";
import { fakeEngageRedis } from "../../helpers/fake-engage-redis";

const e = (n: number, o: Partial<LogEntry> = {}): LogEntry => ({ ref: `${1000 + n}.000100`, author: "U0PERSON", isBot: false, text: `message ${n}`, ...o });
const K = logKey("slack", "C0EXAMPLE");

function suite(name: string, make: (o?: { now?: () => number }) => { log: ConversationLog; expire?: () => void }) {
  describe(name, () => {
    test("appends and reads in order, newest `limit` only", async () => {
      const { log } = make();
      for (let i = 1; i <= 5; i++) await log.append(K, e(i));
      expect((await log.recent(K, 10)).map((x) => x.text)).toEqual(["message 1", "message 2", "message 3", "message 4", "message 5"]);
      expect((await log.recent(K, 2)).map((x) => x.text)).toEqual(["message 4", "message 5"]);
    });
    test("caps at 30 and keeps the newest", async () => {
      const { log } = make();
      for (let i = 1; i <= LOG_CAP + 5; i++) await log.append(K, e(i));
      const all = await log.recent(K, 100);
      expect(all).toHaveLength(LOG_CAP);
      expect(all[0]!.text).toBe("message 6");
      expect(all.at(-1)!.text).toBe(`message ${LOG_CAP + 5}`);
    });
    test("a second append with the same ref is ignored", async () => {
      const { log } = make();
      await log.append(K, e(1));
      await log.append(K, e(1, { text: "again" }));
      expect((await log.recent(K, 10)).map((x) => x.text)).toEqual(["message 1"]);
    });
    test("a thread and its channel are separate conversations", async () => {
      const { log } = make();
      await log.append(K, e(1));
      await log.append(logKey("slack", "C0EXAMPLE", "1000.000100"), e(2, { threadRef: "1000.000100" }));
      expect((await log.recent(K, 10)).map((x) => x.text)).toEqual(["message 1"]);
      const t = await log.recent(logKey("slack", "C0EXAMPLE", "1000.000100"), 10);
      expect(t.map((x) => x.text)).toEqual(["message 2"]);
      expect(t[0]!.threadRef).toBe("1000.000100");
      expect(await log.recent(logKey("slack", "C0OTHER"), 10)).toEqual([]);
    });
    test("forget removes one entry and leaves the others; forgetting an unknown ref is harmless", async () => {
      const { log } = make();
      for (let i = 1; i <= 3; i++) await log.append(K, e(i));
      await log.forget(K, e(2).ref);
      await log.forget(K, "9999.000100");
      await log.forget(logKey("slack", "C0NOTHING"), e(1).ref);
      expect((await log.recent(K, 10)).map((x) => x.text)).toEqual(["message 1", "message 3"]);
      // The ref can be appended again (an edit is heard as a new message).
      await log.append(K, e(2, { text: "edited" }));
      expect((await log.recent(K, 10)).map((x) => x.text)).toEqual(["message 1", "message 3", "edited"]);
    });
    test("forget matches the whole ref, not a prefix of another", async () => {
      const { log } = make();
      await log.append(K, e(1, { ref: "1000.000100" }));
      await log.append(K, e(2, { ref: "1000.0001001" }));
      await log.forget(K, "1000.000100");
      expect((await log.recent(K, 10)).map((x) => x.ref)).toEqual(["1000.0001001"]);
    });
    test("text is cut, and the flags and agent survive", async () => {
      const { log } = make();
      await log.append(K, e(1, { text: "x".repeat(5000), isBot: true, agent: "ana" }));
      const [got] = await log.recent(K, 1);
      expect(got!.text).toHaveLength(LOG_TEXT_CHARS);
      expect(got!.isBot).toBe(true);
      expect(got!.agent).toBe("ana");
    });
  });
}

let clock = 1_000_000;
suite("memory log", () => ({ log: memoryConversationLog(() => clock) }));
suite("redis log", () => ({ log: redisConversationLog(fakeEngageRedis({ now: () => clock })) }));

describe("expiry", () => {
  test("memory: a conversation is forgotten after 24 hours without an append", async () => {
    let t = 0;
    const log = memoryConversationLog(() => t);
    await log.append(K, e(1));
    t = 23 * 3600_000;
    expect(await log.recent(K, 5)).toHaveLength(1);
    t = 25 * 3600_000;
    expect(await log.recent(K, 5)).toEqual([]);
  });
  test("redis: the list expires after 24 hours", async () => {
    let t = 0;
    const log = redisConversationLog(fakeEngageRedis({ now: () => t }));
    await log.append(K, e(1));
    t = 23 * 3600_000;
    expect(await log.recent(K, 5)).toHaveLength(1);
    t = 25 * 3600_000;
    expect(await log.recent(K, 5)).toEqual([]);
  });
});

describe("redis failures", () => {
  test("an error reads as no entries and loses the append, and nothing throws", async () => {
    let down = false;
    const r = fakeEngageRedis({ fail: () => down });
    const log = redisConversationLog(r);
    await log.append(K, e(1));
    down = true;
    expect(await log.recent(K, 5)).toEqual([]);
    await log.append(K, e(2));
    down = false;
    expect((await log.recent(K, 5)).map((x) => x.text)).toEqual(["message 1"]);
  });
  test("a Redis that never answers is cut off at the time budget", async () => {
    const hang = new Promise<never>(() => {});
    const log = redisConversationLog({ eval: () => hang, lrange: () => hang } as any, "slaude", { budgetMs: 30 });
    const t0 = Date.now();
    await log.append(K, e(1));
    expect(await log.recent(K, 5)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  test("two replicas share one log", async () => {
    const r = fakeEngageRedis();
    const a = redisConversationLog(r);
    const b = redisConversationLog(r);
    await a.append(K, e(1));
    await b.append(K, e(1));
    await b.append(K, e(2));
    expect((await a.recent(K, 5)).map((x) => x.text)).toEqual(["message 1", "message 2"]);
  });
});

describe("toThreadMsg", () => {
  const own = { persona: "ana", userId: "UANA1" };
  const userOf = (p: string) => (p === "bo" ? "UBO1" : undefined);
  test("a person's message keeps its author and ts", () => {
    expect(toThreadMsg(e(1, { threadRef: "1.0" }), own, userOf)).toEqual({ ts: "1001.000100", text: "message 1", user: "U0PERSON", thread_ts: "1.0" });
  });
  test("this persona's own post carries its user id; another agent is marked as an agent", () => {
    expect(toThreadMsg(e(1, { agent: "ana", isBot: true, author: "" }), own, userOf)).toMatchObject({ user: "UANA1", bot_id: AGENT_BOT_ID });
    expect(toThreadMsg(e(1, { agent: "bo", isBot: true }), own, userOf)).toMatchObject({ user: "UBO1", bot_id: AGENT_BOT_ID });
    const other = toThreadMsg(e(1, { agent: "default", isBot: true, author: "" }), own, userOf);
    expect(other.user).toBeUndefined();
    expect(other.bot_id).toBe(AGENT_BOT_ID);
  });
  test("another bot is a bot message with no user", () => {
    const m = toThreadMsg(e(1, { isBot: true, author: "B0CI" }), own, userOf);
    expect(m).toMatchObject({ bot_id: "B0CI", subtype: "bot_message" });
    expect(m.user).toBeUndefined();
  });
});
