import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";
import { BunSqlClient, PoolGate, type PoolGateOptions } from "../../src/db/drivers/pg";

/** A pool stand-in that records how many statements are in flight at once. */
function fake(size = 4, gateOpts: PoolGateOptions = {}, over: { reserve?: () => Promise<unknown>; unsafe?: (sql: string) => Promise<unknown> } = {}) {
  let live = 0;
  let peak = 0;
  let started = 0;
  const gate = new PoolGate(size, gateOpts);
  const unsafe =
    over.unsafe ??
    (async (_sql: string) => {
      started++;
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return [] as unknown[];
    });
  const root = {
    reserve: over.reserve ?? (async () => ({ unsafe, release: () => {} })),
    begin: async (fn: (tx: { unsafe: () => Promise<unknown[]> }) => Promise<unknown>) => {
      live++;
      peak = Math.max(peak, live);
      try {
        return await fn({ unsafe: async () => (started++, await new Promise((r) => setTimeout(r, 2)), [] as unknown[]) }); // the transaction's own connection
      } finally {
        live--;
      }
    },
  } as never;
  return { client: new BunSqlClient({ unsafe } as never, root, false, gate), gate, peak: () => peak, started: () => started };
}

describe("the pool gate", () => {
  test("never lets more statements into the pool than its size, and every one still completes", async () => {
    const { client, peak, started } = fake();
    await Promise.all(Array.from({ length: 50 }, (_, i) => client.query("SELECT ?", [i])));
    await Promise.all(Array.from({ length: 50 }, (_, i) => client.run("UPDATE t SET a = ?", [i])));
    expect(started()).toBe(100);
    expect(peak()).toBeLessThanOrEqual(4);
  });

  test("a transaction holds one permit for its whole duration, and its own statements need none", async () => {
    const { client, peak } = fake();
    const txs = Array.from({ length: 10 }, () =>
      client.transaction(async (tx) => {
        await tx.query("SELECT 1");
        await tx.run("UPDATE t SET a = 1");
      }),
    );
    await Promise.all([...txs, ...Array.from({ length: 20 }, () => client.query("SELECT 2"))]);
    expect(peak()).toBeLessThanOrEqual(4);
  });

  test("a rejected statement or a throwing transaction gives its permit back", async () => {
    let fail = true;
    const { client, gate } = fake(2, {}, { unsafe: async () => { if (fail) throw new Error("boom"); return []; } });
    for (let i = 0; i < 5; i++) await expect(client.query("SELECT 1")).rejects.toThrow("boom");
    await expect(client.run("UPDATE t SET a = 1")).rejects.toThrow("boom");
    await expect(client.transaction(async () => { throw new Error("tx boom"); })).rejects.toThrow("tx boom");
    fail = false;
    await client.query("SELECT 1"); // would hang if a permit leaked
    expect(gate.waiting).toBe(0);
  });

  test("an advisory lock holds a permit until it is released", async () => {
    const gate = new PoolGate(1);
    const client = new BunSqlClient({ unsafe: async () => [] } as never, { reserve: async () => ({ unsafe: async () => [{ ok: true }], release: () => {} }) } as never, false, gate);
    const unlock = await client.advisoryLock!(1, 2, {});
    let ran = false;
    const waiting = client.query("SELECT 1").then(() => (ran = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
    expect(gate.waiting).toBe(1);
    await unlock();
    await waiting;
    expect(ran).toBe(true);
  });

  test("every advisory-lock failure path gives the permit back", async () => {
    // reserve() throws
    let g = new PoolGate(1);
    let c = new BunSqlClient({ unsafe: async () => [] } as never, { reserve: async () => { throw new Error("no connection"); } } as never, false, g);
    await expect(c.advisoryLock!(1, 2)).rejects.toThrow("no connection");
    await g.acquire(); // would hang on a leak
    g.release();
    // the try-lock statement throws
    g = new PoolGate(1);
    let released = 0;
    c = new BunSqlClient({ unsafe: async () => [] } as never, { reserve: async () => ({ unsafe: async () => { throw new Error("try failed"); }, release: () => void released++ }) } as never, false, g);
    await expect(c.advisoryLock!(1, 2)).rejects.toThrow("try failed");
    expect(released).toBe(1);
    await g.acquire();
    g.release();
    // release() itself throws: the permit is still returned
    g = new PoolGate(1);
    c = new BunSqlClient({ unsafe: async () => [] } as never, { reserve: async () => ({ unsafe: async () => { throw new Error("try failed"); }, release: () => { throw new Error("release failed"); } }) } as never, false, g);
    await expect(c.advisoryLock!(1, 2)).rejects.toThrow();
    await g.acquire();
    g.release();
    // unlock: the unlock statement fails and release throws, the permit still comes back
    g = new PoolGate(1);
    c = new BunSqlClient({ unsafe: async () => [] } as never, { reserve: async () => ({ unsafe: async (s: string) => (s.includes("unlock") ? Promise.reject(new Error("unlock failed")) : [{ ok: true }]), release: () => { throw new Error("release failed"); } }) } as never, false, g);
    const unlock = await c.advisoryLock!(1, 2);
    await expect(unlock()).rejects.toThrow();
    await g.acquire();
    g.release();
  });
});

describe("pool gate observability", () => {
  test("a long wait counts and warns once per window, the queue depth is reported, and the wait is granted in order", async () => {
    const warns: string[] = [];
    const events: string[] = [];
    const depth: number[] = [];
    const gate = new PoolGate(1, { slowMs: 10, warn: (m) => warns.push(m), onEvent: (o) => events.push(o), onWaiting: (n) => depth.push(n) });
    await gate.acquire();
    const order: number[] = [];
    const a = gate.acquire().then(() => order.push(1));
    const b = gate.acquire().then(() => order.push(2));
    await new Promise((r) => setTimeout(r, 40));
    expect(events.filter((e) => e === "slow")).toHaveLength(2);
    expect(warns).toHaveLength(1); // one warning per window, counts for each
    expect(warns[0]).toContain("waiting");
    gate.release();
    await a;
    gate.release();
    await b;
    expect(order).toEqual([1, 2]);
    expect(Math.max(...depth)).toBe(2);
    expect(depth[depth.length - 1]).toBe(0);
  });

  test("an acquire timeout fails the waiter, frees its place, and a later release still serves the next one", async () => {
    const events: string[] = [];
    const gate = new PoolGate(1, { acquireTimeoutMs: 15, onEvent: (o) => events.push(o) });
    await gate.acquire();
    await expect(gate.acquire()).rejects.toThrow(/waited 15ms/);
    expect(gate.waiting).toBe(0);
    expect(events).toContain("timeout");
    const next = gate.acquire(); // no timeout survives a grant: queue one and release
    gate.release();
    await next;
    gate.release();
  });
});

describe("SLAUDE_PG_POOL", () => {
  afterEach(() => {
    delete process.env.SLAUDE_PG_POOL;
  });
  test("1 is raised to 2 (an advisory lock holds one connection and needs another); larger values are kept; junk is refused", () => {
    process.env.SLAUDE_PG_POOL = "1";
    expect(env.db.pgPool()).toBe(2);
    process.env.SLAUDE_PG_POOL = "6";
    expect(env.db.pgPool()).toBe(6);
    process.env.SLAUDE_PG_POOL = "0";
    expect(() => env.db.pgPool()).toThrow();
  });
});
