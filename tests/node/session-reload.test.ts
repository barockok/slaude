import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "../queue/real";
import type { Keys } from "../../src/queue/keys";
import type { PubSub } from "../../src/queue/pubsub";

const prefix = testPrefix("sesreload");

/** The slice of AgentManager the worker uses for a reload. */
const fakeAgent = () => {
  const calls: Array<[string, string | undefined]> = [];
  return {
    calls,
    reloadAfterTurn(id: string, prompt?: string): boolean {
      calls.push([id, prompt]);
      return true;
    },
  };
};

describe.skipIf(!realEnabled)("node session reload wiring against real Redis", () => {
  let redis: Redis;
  let sub: Redis;
  let keys: Keys;
  let ps: PubSub;
  let wiring: typeof import("../../src/node/session-reload");

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { makePubSub } = await import("../../src/queue/pubsub");
    wiring = await import("../../src/node/session-reload");
    redis = realRedis();
    sub = realRedis();
    keys = makeKeys(prefix);
    ps = makePubSub({ redis, sub, keys });
  })();

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await ps.close();
    await cleanupPrefix(redis, prefix);
    await Promise.all([redis.quit(), sub.quit()]);
  });

  test("a reload published during a turn reaches the agent with its prompt and consumes the durable flag", async () => {
    await ready;
    const agent = fakeAgent();
    const off = await wiring.subscribeSessionReload(ps, agent, "turn-1");
    await ps.publishSessionReload("turn-1", "carry on");
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]).toEqual(["turn-1", "carry on"]);
    // Serviced now, so the flag must not linger and reload the session's next turn too.
    await until(async () => (await redis.get(keys.sessionReloadFlag("turn-1"))) === null);
    await off();
  });

  test("after the turn the subscription is gone: a later reload is only a flag", async () => {
    await ready;
    const agent = fakeAgent();
    const off = await wiring.subscribeSessionReload(ps, agent, "turn-2");
    await off();
    await ps.publishSessionReload("turn-2");
    await sleep(150);
    expect(agent.calls).toEqual([]);
    expect(await redis.get(keys.sessionReloadFlag("turn-2"))).not.toBeNull();
    await ps.consumeSessionReloadFlag("turn-2");
  });

  test("a flag set while no node held the session reloads at the next claim, once, without a prompt", async () => {
    await ready;
    const agent = fakeAgent();
    await ps.publishSessionReload("claim-1", "ignored here: this turn brings its own message");
    expect(await wiring.applyPendingSessionReload(ps, agent, "claim-1")).toBe(true);
    expect(agent.calls).toEqual([["claim-1", undefined]]);
    expect(await wiring.applyPendingSessionReload(ps, agent, "claim-1")).toBe(false);
    expect(agent.calls).toHaveLength(1);
  });

  test("a failing flag read never blocks the turn", async () => {
    await ready;
    const agent = fakeAgent();
    const broken = { consumeSessionReloadFlag: async () => { throw new Error("redis down"); } };
    expect(await wiring.applyPendingSessionReload(broken as never, agent, "claim-2")).toBe(false);
    expect(agent.calls).toEqual([]);
  });
});
