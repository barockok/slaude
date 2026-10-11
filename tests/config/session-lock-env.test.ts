/**
 * The session lock's TTL is how long a dead node keeps its session.
 *
 * A killed node never releases `lock:session:<id>`, so the turn that is
 * re-delivered to another node waits for that lock to expire before it can run.
 * The default is ten minutes, which tolerates a very long stall inside a live
 * node and costs that long a takeover when one dies. Deployments that would
 * rather take over quickly can say so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";

const saved = {
  ttl: process.env.SLAUDE_SESSION_LOCK_TTL_MS,
  extend: process.env.SLAUDE_SESSION_LOCK_EXTEND_MS,
};

afterEach(() => {
  for (const [k, v] of [
    ["SLAUDE_SESSION_LOCK_TTL_MS", saved.ttl],
    ["SLAUDE_SESSION_LOCK_EXTEND_MS", saved.extend],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("session lock timings", () => {
  test("the defaults are unchanged: ten minutes, renewed every minute", () => {
    delete process.env.SLAUDE_SESSION_LOCK_TTL_MS;
    delete process.env.SLAUDE_SESSION_LOCK_EXTEND_MS;
    expect(env.sessionLock()).toEqual({ ttlMs: 600_000, extendEveryMs: 60_000 });
  });

  test("both are overridable", () => {
    process.env.SLAUDE_SESSION_LOCK_TTL_MS = "90000";
    process.env.SLAUDE_SESSION_LOCK_EXTEND_MS = "15000";
    expect(env.sessionLock()).toEqual({ ttlMs: 90_000, extendEveryMs: 15_000 });
  });

  // A TTL at or below the renewal cadence would expire a live node's lock
  // between renewals, handing its session to someone else mid-turn.
  test("a TTL that does not comfortably exceed the renewal cadence is refused", () => {
    process.env.SLAUDE_SESSION_LOCK_TTL_MS = "20000";
    process.env.SLAUDE_SESSION_LOCK_EXTEND_MS = "15000";
    expect(() => env.sessionLock()).toThrow(/SLAUDE_SESSION_LOCK_TTL_MS/);
  });

  test("nonsense values are refused rather than silently defaulted", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      process.env.SLAUDE_SESSION_LOCK_TTL_MS = bad;
      delete process.env.SLAUDE_SESSION_LOCK_EXTEND_MS;
      expect(() => env.sessionLock()).toThrow();
    }
  });
});
