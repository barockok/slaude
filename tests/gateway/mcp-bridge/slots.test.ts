/**
 * The bridge's concurrency slots: a waiter whose call is already aborted, or
 * is aborted while it waits, returns at once and is never handed a slot; a
 * freed slot goes to the next live waiter.
 */
import { describe, expect, test } from "bun:test";
import { Slots } from "../../../src/gateway/core/mcp-bridge";

const soon = () => Date.now() + 5_000;

describe("Slots", () => {
  test("an already-aborted call returns false immediately and takes no place in the queue", async () => {
    const s = new Slots();
    expect(await s.acquire("k", 1, soon())).toBe(true);
    const dead = new AbortController();
    dead.abort();
    const t0 = Date.now();
    expect(await s.acquire("k", 1, soon(), dead.signal)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
    // Also with a free slot: an aborted call never takes it.
    expect(await new Slots().acquire("k", 1, soon(), dead.signal)).toBe(false);
    // The freed slot goes to the next LIVE waiter.
    const live = s.acquire("k", 1, soon());
    s.release("k");
    expect(await live).toBe(true);
    expect(s.active("k")).toBe(1);
    s.release("k");
    expect(s.active("k")).toBe(0);
  });

  test("a waiter aborted while waiting gives up its place; the next waiter gets the slot", async () => {
    const s = new Slots();
    expect(await s.acquire("k", 1, soon())).toBe(true);
    const ac = new AbortController();
    const first = s.acquire("k", 1, soon(), ac.signal);
    const second = s.acquire("k", 1, soon());
    ac.abort();
    expect(await first).toBe(false);
    s.release("k");
    expect(await second).toBe(true);
  });

  test("a waiter past its deadline gives up", async () => {
    const s = new Slots();
    await s.acquire("k", 1, soon());
    expect(await s.acquire("k", 1, Date.now() + 30)).toBe(false);
  });
});
