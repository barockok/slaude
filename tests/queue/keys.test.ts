import { afterEach, describe, expect, test } from "bun:test";
import { assertNodeIdUsable, labelTurnsQueue, makeKeys, nodeTurnsQueue, redisPrefix, TURNS_QUEUE } from "../../src/queue/keys";
import { LABEL_RE as CREDENTIAL_LABEL_RE } from "../../src/gateway/auth/node-credential";

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
    expect(k.abortFlag("s1")).toBe("p:abort-flag:s1");
    expect(k.reloadChannel("t1")).toBe("p:reload:t1");
    expect(k.gateChannel("g1")).toBe("p:gate:g1");
    expect(k.eventsStream("s1")).toBe("p:events:s1");
    expect(k.turnDone("j1")).toBe("p:turn-done:j1");
    expect(k.nodeLabels("n1")).toBe("p:nodelabels:n1");
    expect(k.jobMoved("j1")).toBe("p:job-moved:j1");
    // The labels key must never match the heartbeat SCAN pattern.
    expect(k.nodeLabels("n1").startsWith("p:nodes:")).toBe(false);
  });

  test("queue names: shared is bare, per-node dots the nodeId in", () => {
    expect(TURNS_QUEUE).toBe("turns");
    expect(nodeTurnsQueue("host-ab12")).toBe("turns.host-ab12");
  });

  test("nodeTurnsQueue sanitizes colons (BullMQ rejects ':' in queue names)", () => {
    expect(nodeTurnsQueue("host:8081:x")).toBe("turns.host-8081-x");
    expect(nodeTurnsQueue("host:8081:x")).not.toContain(":");
  });

  // Node labels spec §4.6.
  test("label queues: default keeps the bare name, any other is turns.label.<label>", () => {
    expect(labelTurnsQueue("default")).toBe(TURNS_QUEUE);
    expect(labelTurnsQueue("finance")).toBe("turns.label.finance");
    for (const bad of ["Finance", "a:b", "-x", "", "a".repeat(33)]) expect(() => labelTurnsQueue(bad)).toThrow();
  });

  test("a node id whose queue would be a label queue is refused", () => {
    expect(() => assertNodeIdUsable("label.finance")).toThrow(/reserved/);
    expect(() => assertNodeIdUsable("label:finance")).not.toThrow(); // turns.label-finance
    expect(() => assertNodeIdUsable("host-ab12")).not.toThrow();
    expect(() => assertNodeIdUsable("labels-host")).not.toThrow();
  });

  test("the queue layer and the node credential share one label pattern", () => {
    expect(CREDENTIAL_LABEL_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,31}$");
  });
});
