/**
 * The session pool under failure (review round on U12):
 *   - a call interrupted on a session the upstream forgot retires that
 *     session, so later calls do not keep failing until idle expiry;
 *   - a shared session open has its own timeout, not its first opener's
 *     remaining budget;
 *   - a caller waiting on a shared open honours its own abort;
 *   - a closed, retired or idle-expired session is ended upstream (DELETE),
 *     best effort and never in the way of a call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cancelledText, createMcpBridge, interruptedText, timeoutText, type BridgeLimits } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { startUpstream, type Upstream } from "./upstream";

const claims: JobClaims = {
  tenant: "t1", persona: "default", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs: "agent", exp: 0,
};
const LIMITS: BridgeLimits = { timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 };
const ups: Upstream[] = [];
afterAll(() => {
  for (const u of ups) u.stop();
});
const upstream = (o: Parameters<typeof startUpstream>[0] = {}) => {
  const u = startUpstream(o);
  ups.push(u);
  return u;
};
const bridgeAt = (url: string, limits: Partial<BridgeLimits> = {}, now?: () => number) =>
  createMcpBridge({
    ...(now ? { now } : {}),
    servers: () => ({ servers: { s: { type: "http", url } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
    limits: () => ({ ...LIMITS, ...limits }),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
};
const count = (up: Upstream, m: string) => up.methods.filter((x) => x === m).length;
const deletes = (up: Upstream) => up.verbs.filter((v) => v === "DELETE").length;
const text = (t: string) => [{ type: "text", text: t }];

describe("an interrupted call retires its session", () => {
  test("an upstream answering 500 for a forgotten session: one call is interrupted, the next opens a fresh session", async () => {
    const up = upstream({ unknownSessionStatus: 500 });
    const b = bridgeAt(up.url);
    try {
      await b.call(claims, "s", "echo", { text: "warm" });
      up.restart();
      expect(await b.call(claims, "s", "echo", { text: "lost" })).toEqual({ content: text(interruptedText("s")), isError: true });
      expect((await b.call(claims, "s", "echo", { text: "next" })).content).toEqual(text("next"));
      // At most once: the interrupted call was not repeated.
      expect(count(up, "tools/call")).toBe(3);
      expect(count(up, "initialize")).toBe(2);
    } finally {
      await b.close();
    }
  });
});

describe("a shared session open", () => {
  test("has its own timeout: a waiter with a full budget is not failed by the first opener's short one", async () => {
    const gate = Promise.withResolvers<void>();
    const up = upstream({
      onInitialize: async (n) => {
        // The first open fails late, so its caller re-opens with little budget left.
        if (n === 1) {
          await sleep(700);
          return new Response("unavailable", { status: 503 });
        }
        if (n === 2) return void (await gate.promise);
        return new Response("unavailable", { status: 503 });
      },
    });
    const b = bridgeAt(up.url, { timeoutMs: 1000 });
    try {
      const a = b.call({ ...claims, session: "S-A" }, "s", "echo", { text: "a" });
      await until(() => count(up, "initialize") === 2);
      const late = b.call({ ...claims, session: "S-B" }, "s", "echo", { text: "b" });
      // Past A's deadline, well inside B's.
      await sleep(450);
      gate.resolve();
      expect((await late).content).toEqual(text("b"));
      expect((await a).content).toEqual(text(timeoutText("s", 1000)));
      expect(count(up, "initialize")).toBe(2);
    } finally {
      gate.resolve();
      await b.close();
    }
  });

  test("a waiter that is aborted returns cancelled at once and frees its slots; the open carries on for others", async () => {
    const gate = Promise.withResolvers<void>();
    const up = upstream({ onInitialize: async () => void (await gate.promise) });
    const b = bridgeAt(up.url, { sessionConcurrency: 1 });
    // A safety net so a regression fails on the timing assertion, not on a hang.
    const release = setTimeout(() => gate.resolve(), 1500);
    try {
      const ac = new AbortController();
      const first = b.call(claims, "s", "echo", { text: "x" }, ac.signal);
      await until(() => count(up, "initialize") === 1);
      const t0 = Date.now();
      ac.abort();
      expect((await first).content).toEqual(text(cancelledText("s")));
      expect(Date.now() - t0).toBeLessThan(500);
      // Same thread, concurrency 1: it gets the slot, and joins the same open.
      const next = b.call(claims, "s", "echo", { text: "y" });
      gate.resolve();
      expect((await next).content).toEqual(text("y"));
      expect(count(up, "initialize")).toBe(1);
    } finally {
      clearTimeout(release);
      gate.resolve();
      await b.close();
    }
  });
});

describe("a session taken out of service is ended upstream", () => {
  test("an idle-expired session is terminated with DELETE", async () => {
    const up = upstream();
    let clock = Date.now();
    const b = bridgeAt(up.url, { idleMs: 60_000 }, () => clock);
    try {
      await b.call(claims, "s", "echo", { text: "a" });
      clock += 61_000;
      await b.call(claims, "s", "echo", { text: "b" });
      await until(() => deletes(up) === 1 && up.sessions() === 1);
    } finally {
      await b.close();
    }
  });

  test("an interrupted call's session is terminated with DELETE", async () => {
    const up = upstream();
    const b = bridgeAt(up.url);
    try {
      expect((await b.call(claims, "s", "fault_502", {})).content).toEqual(text(interruptedText("s")));
      await until(() => deletes(up) === 1 && up.sessions() === 0);
    } finally {
      await b.close();
    }
  });

  test("closing the bridge terminates its sessions", async () => {
    const up = upstream();
    const b = bridgeAt(up.url);
    await b.call(claims, "s", "echo", { text: "a" });
    expect(up.sessions()).toBe(1);
    await b.close();
    await until(() => deletes(up) === 1 && up.sessions() === 0);
  });

  test("a DELETE the upstream never answers does not hold up a call and is given up after a bound", async () => {
    const up = upstream({ hangDelete: true });
    let clock = Date.now();
    const b = bridgeAt(up.url, { idleMs: 60_000 }, () => clock);
    try {
      await b.call(claims, "s", "echo", { text: "a" });
      clock += 61_000;
      const t0 = Date.now();
      expect((await b.call(claims, "s", "echo", { text: "b" })).content).toEqual(text("b"));
      expect(Date.now() - t0).toBeLessThan(1000);
      await until(() => deletes(up) === 1);
      // The termination is abandoned (its connection dropped) after its bound.
      await until(() => up.deleteAborts === 1, 4000);
    } finally {
      await b.close();
    }
  });
});
