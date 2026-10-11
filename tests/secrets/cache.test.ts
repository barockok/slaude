import { describe, expect, test } from "bun:test";
import { createSecretCache } from "../../src/secrets/cache";
import { SecretResolutionError } from "../../src/secrets/errors";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("secret cache", () => {
  test("within TTL the cached value is served without a fetch", async () => {
    const c = clock();
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now });
    let calls = 0;
    const fetch = async () => `v${++calls}`;
    expect(await cache.get("k", fetch)).toEqual({ value: "v1", outcome: "ok" });
    c.advance(59_999);
    expect(await cache.get("k", fetch)).toEqual({ value: "v1", outcome: "cached" });
    expect(calls).toBe(1);
  });

  test("past TTL the next caller refreshes", async () => {
    const c = clock();
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now });
    let calls = 0;
    const fetch = async () => `v${++calls}`;
    await cache.get("k", fetch);
    c.advance(60_000);
    expect(await cache.get("k", fetch)).toEqual({ value: "v2", outcome: "ok" });
    expect(calls).toBe(2);
  });

  test("TTL 0: every call fetches and nothing is kept for stale serving", async () => {
    const c = clock();
    let stale = 0;
    const cache = createSecretCache({ ttlMs: 0, staleMaxMs: 600_000, now: c.now, onStale: () => stale++ });
    let calls = 0;
    await cache.get("k", async () => `v${++calls}`);
    await cache.get("k", async () => `v${++calls}`);
    expect(calls).toBe(2);
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("unreachable", "down");
      }),
    ).rejects.toThrow(SecretResolutionError);
    expect(stale).toBe(0);
  });

  test("single flight: N concurrent callers share one upstream request", async () => {
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: clock().now });
    const d = deferred<string>();
    let calls = 0;
    const fetch = () => {
      calls++;
      return d.promise;
    };
    const all = Promise.all(Array.from({ length: 25 }, () => cache.get("k", fetch)));
    d.resolve("v");
    const results = await all;
    expect(calls).toBe(1);
    expect(results.every((r) => r.value === "v")).toBe(true);
  });

  test("single flight also under TTL 0", async () => {
    const cache = createSecretCache({ ttlMs: 0, staleMaxMs: 0, now: clock().now });
    const d = deferred<string>();
    let calls = 0;
    const all = Promise.all(
      Array.from({ length: 10 }, () =>
        cache.get("k", () => {
          calls++;
          return d.promise;
        }),
      ),
    );
    d.resolve("v");
    await all;
    expect(calls).toBe(1);
  });

  test("different keys do not share a flight", async () => {
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: clock().now });
    let calls = 0;
    await Promise.all([cache.get("a", async () => `${++calls}`), cache.get("b", async () => `${++calls}`)]);
    expect(calls).toBe(2);
  });

  test("a failed refresh within STALE_MAX serves the cached value and bumps the counter", async () => {
    const c = clock();
    let stale = 0;
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now, onStale: () => stale++ });
    await cache.get("k", async () => "v1");
    c.advance(300_000);
    const r = await cache.get("k", async () => {
      throw new SecretResolutionError("timeout", "slow");
    });
    expect(r).toEqual({ value: "v1", outcome: "stale" });
    expect(stale).toBe(1);
  });

  test("a failed refresh past STALE_MAX fails", async () => {
    const c = clock();
    let stale = 0;
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now, onStale: () => stale++ });
    await cache.get("k", async () => "v1");
    c.advance(600_000);
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("unreachable", "down");
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(stale).toBe(0);
  });

  test("a definitive answer (secret gone, policy denied) is never masked by a stale value", async () => {
    const c = clock();
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now });
    await cache.get("k", async () => "v1");
    c.advance(61_000);
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("missing_field", "gone");
      }),
    ).rejects.toMatchObject({ reason: "missing_field" });
    // …and the entry is dropped so a later outage cannot resurrect it.
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("unreachable", "down");
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  test("a clock that jumps backwards neither extends the TTL nor the stale window", async () => {
    const c = clock();
    let stale = 0;
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now, onStale: () => stale++ });
    let calls = 0;
    await cache.get("k", async () => `v${++calls}`);
    c.advance(-3_600_000);
    // age unknown ⇒ not fresh: refresh
    expect(await cache.get("k", async () => `v${++calls}`)).toEqual({ value: "v2", outcome: "ok" });
    c.advance(-3_600_000);
    // age unknown ⇒ not within STALE_MAX either
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("unreachable", "down");
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(stale).toBe(0);
  });

  test("entries older than STALE_MAX are evicted on access", async () => {
    const c = clock();
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: c.now });
    await cache.get("old-a", async () => "a");
    await cache.get("old-b", async () => "b");
    expect(cache.size()).toBe(2);
    c.advance(600_000);
    await cache.get("new", async () => "n");
    expect(cache.size()).toBe(1);
  });

  test("a failed fetch is not cached: the next caller tries again", async () => {
    const cache = createSecretCache({ ttlMs: 60_000, staleMaxMs: 600_000, now: clock().now });
    await expect(
      cache.get("k", async () => {
        throw new SecretResolutionError("unreachable", "down");
      }),
    ).rejects.toThrow();
    expect(await cache.get("k", async () => "v")).toEqual({ value: "v", outcome: "ok" });
  });
});
