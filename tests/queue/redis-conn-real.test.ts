import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REAL_URL, realEnabled } from "./real";

// Covers src/queue/redis.ts: env accessors + lazy singletons. Gated like the
// rest — the module's import is deferred so the redis-less leg never loads it.

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SLAUDE_REDIS_URL", "SLAUDE_REDIS_PREFIX", "SLAUDE_HEARTBEAT_SEC", "SLAUDE_NODE_DRAIN_SEC"];

describe.skipIf(!realEnabled)("queue/redis connection factory", () => {
  let mod: typeof import("../../src/queue/redis");

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    mod = await import("../../src/queue/redis");
  });

  afterAll(async () => {
    if (!realEnabled) return;
    await mod.closeRedis();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("env accessors: defaults and overrides", () => {
    delete process.env.SLAUDE_REDIS_URL;
    delete process.env.SLAUDE_HEARTBEAT_SEC;
    delete process.env.SLAUDE_NODE_DRAIN_SEC;
    expect(mod.redisUrl()).toBe("redis://localhost:6379");
    expect(mod.heartbeatSec()).toBe(10);
    expect(mod.nodeDrainSec()).toBe(120);

    process.env.SLAUDE_REDIS_URL = "redis://example:1234";
    process.env.SLAUDE_HEARTBEAT_SEC = "3";
    process.env.SLAUDE_NODE_DRAIN_SEC = "45";
    expect(mod.redisUrl()).toBe("redis://example:1234");
    expect(mod.heartbeatSec()).toBe(3);
    expect(mod.nodeDrainSec()).toBe(45);

    // garbage falls back
    process.env.SLAUDE_HEARTBEAT_SEC = "banana";
    process.env.SLAUDE_NODE_DRAIN_SEC = "-1";
    expect(mod.heartbeatSec()).toBe(10);
    expect(mod.nodeDrainSec()).toBe(120);
  });

  test("lazy singletons: shared main + separate sub, reset by closeRedis", async () => {
    process.env.SLAUDE_REDIS_URL = REAL_URL;
    const main = mod.getRedis();
    expect(mod.getRedis()).toBe(main); // singleton
    const sub = mod.getSubRedis();
    expect(mod.getSubRedis()).toBe(sub);
    expect(sub).not.toBe(main); // subscriber gets its own connection
    expect(await main.ping()).toBe("PONG");

    await mod.closeRedis();
    const fresh = mod.getRedis();
    expect(fresh).not.toBe(main); // closed singletons are replaced
    expect(await fresh.ping()).toBe("PONG");
    await mod.closeRedis();
    await mod.closeRedis(); // idempotent
  });

  test("createRedis returns dedicated BullMQ-compatible connections", async () => {
    const a = mod.createRedis(REAL_URL);
    const b = mod.createRedis(REAL_URL);
    expect(a).not.toBe(b);
    expect(a.options.maxRetriesPerRequest).toBeNull();
    expect(await a.ping()).toBe("PONG");
    await Promise.all([a.quit(), b.quit()]);
  });
});
