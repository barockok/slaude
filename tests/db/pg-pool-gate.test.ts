import { describe, expect, test } from "bun:test";
import { BunSqlClient, PoolGate } from "../../src/db/drivers/pg";

/** A pool stand-in that records how many statements are in flight at once. */
function fake(): { client: BunSqlClient; peak: () => number; started: () => number } {
  let live = 0;
  let peak = 0;
  let started = 0;
  const unsafe = async (_sql: string) => {
    started++;
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return [] as unknown[];
  };
  const root = {
    reserve: async () => ({ unsafe, release: () => {} }),
    begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => {
      live++;
      peak = Math.max(peak, live);
      try {
        return await fn({ unsafe: async () => (started++, await new Promise((r) => setTimeout(r, 2)), [] as unknown[]) }); // runs on the transaction's own connection
      } finally {
        live--;
      }
    },
  } as never;
  return { client: new BunSqlClient({ unsafe } as never, root, false, new PoolGate(4)), peak: () => peak, started: () => started };
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

  test("an advisory lock holds a permit until it is released", async () => {
    const { client } = fake();
    const gate = (client as unknown as { gate: PoolGate }).gate;
    const order: string[] = [];
    // take three permits so only one is left, then lock: the lock takes the last one
    await gate.acquire();
    await gate.acquire();
    await gate.acquire();
    const unlock = await client.advisoryLock!(1, 2, {}).catch(() => async () => {});
    let ran = false;
    const waiting = client.query("SELECT 1").then(() => (ran = true));
    await new Promise((r) => setTimeout(r, 20));
    order.push(String(ran));
    await unlock();
    await waiting;
    expect(order).toEqual(["false"]);
    expect(ran).toBe(true);
  });
});
