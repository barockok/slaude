import { describe, expect, test } from "bun:test";
import { BunSqlClient } from "../../src/db/drivers/pg";

/** A reserved connection that records its statements; the blocking lock call times out. */
function fake(): { client: BunSqlClient; log: string[]; released: () => boolean } {
  const log: string[] = [];
  let released = false;
  const reserved = {
    unsafe: async (sql: string) => {
      log.push(sql);
      if (sql.includes("pg_try_advisory_lock")) return [{ ok: false }];
      if (sql.includes("SELECT pg_advisory_lock")) throw new Error("canceling statement due to lock timeout");
      return [];
    },
    release: () => {
      released = true;
    },
  };
  const root = { reserve: async () => reserved } as never;
  return { client: new BunSqlClient({ unsafe: async () => [] } as never, root, false), log, released: () => released };
}

describe("advisoryLock timeout", () => {
  test("a timed out wait resets lock_timeout before the connection goes back to the pool", async () => {
    const { client, log, released } = fake();
    await expect(client.advisoryLock!(1, 2, { timeoutMs: 1000 })).rejects.toThrow(/not acquired within 1000ms/);
    const set = log.findIndex((s) => s === "SET lock_timeout = 1000");
    const reset = log.findIndex((s, i) => i > set && s === "SET lock_timeout = 0");
    expect(set).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(set);
    expect(released()).toBe(true);
  });
});
