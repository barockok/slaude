import { afterEach, describe, expect, test } from "bun:test";
import { makeKeys, nodeTurnsQueue, redisPrefix, TURNS_QUEUE } from "../../src/queue/keys";

// keys.ts is pure (no redis import) — the one queue module the redis-less
// test leg loads and covers. Everything touching a server lives in the
// SLAUDE_REDIS_TEST_URL-gated tests/queue/*-real.test.ts files.

const ORIG = process.env.SLAUDE_REDIS_PREFIX;
afterEach(() => {
  if (ORIG === undefined) delete process.env.SLAUDE_REDIS_PREFIX;
  else process.env.SLAUDE_REDIS_PREFIX = ORIG;
});

describe("queue/keys", () => {
  test("redisPrefix defaults to slaude and honors SLAUDE_REDIS_PREFIX", () => {
    delete process.env.SLAUDE_REDIS_PREFIX;
    expect(redisPrefix()).toBe("slaude");
    process.env.SLAUDE_REDIS_PREFIX = "custom";
    expect(redisPrefix()).toBe("custom");
    expect(makeKeys().prefix).toBe("custom");
  });

  test("every key/channel/queue name hangs off the prefix", () => {
    const k = makeKeys("p");
    expect(k.prefix).toBe("p");
    expect(k.bullPrefix).toBe("p:bull");
    expect(k.sess("s1")).toBe("p:sess:s1");
    expect(k.sessPattern()).toBe("p:sess:*");
    expect(k.node("n1")).toBe("p:nodes:n1");
    expect(k.nodePattern()).toBe("p:nodes:*");
    expect(k.nodeSet()).toBe("p:nodeset");
    expect(k.sessionLock("s1")).toBe("p:lock:session:s1");
    expect(k.leaderLock("reaper")).toBe("p:lock:leader:reaper");
    expect(k.coalesce("s1")).toBe("p:coalesce:s1");
    expect(k.coalesceLock("s1")).toBe("p:lock:coalesce:s1");
    expect(k.abortChannel("s1")).toBe("p:abort:s1");
    expect(k.reloadChannel("t1")).toBe("p:reload:t1");
    expect(k.gateChannel("g1")).toBe("p:gate:g1");
    expect(k.eventsStream("s1")).toBe("p:events:s1");
  });

  test("queue names: shared is bare, per-node dots the nodeId in", () => {
    expect(TURNS_QUEUE).toBe("turns");
    expect(nodeTurnsQueue("host-ab12")).toBe("turns.host-ab12");
  });

  test("nodeTurnsQueue sanitizes colons (BullMQ rejects ':' in queue names)", () => {
    expect(nodeTurnsQueue("host:8081:x")).toBe("turns.host-8081-x");
    expect(nodeTurnsQueue("host:8081:x")).not.toContain(":");
  });
});
