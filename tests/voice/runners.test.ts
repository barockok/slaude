import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { monoRunner, nodeRunner, makeTokenKeeper, waitTurnDone } from "../../src/voice/runners";
import { voiceTurns, injectedTurns } from "../../src/voice/turn-flags";
import { HELD_BY_OTHER } from "../../src/queue/locks";
import { until } from "./fakes";

class StubAgent extends EventEmitter {
  sent: string[] = [];
  suppressed: string[] = [];
  activeDuringSend: boolean[] = [];
  injectedDuringSend: boolean[] = [];
  inFlight = false;
  outcome: "done" | "error" | "hang" | "throw" = "done";
  aborted: string[] = [];
  abort(id: string) { this.aborted.push(id); }
  suppressNextTurn(id: string) { this.suppressed.push(id); }
  isTurnInFlight(_id: string) { return this.inFlight; }
  live = true;
  isLive(_id: string) { return this.live; }
  async sendMessage(id: string, text: string) {
    this.sent.push(text);
    this.activeDuringSend.push(voiceTurns.active(id));
    this.injectedDuringSend.push(injectedTurns.active(id));
    if (this.outcome === "throw") throw new Error("send failed");
    if (this.outcome === "hang") return;
    queueMicrotask(() => this.emit("event", this.outcome === "done" ? { type: "done", sessionId: id } : { type: "error", sessionId: id, error: "boom" }));
  }
}

describe("waitTurnDone", () => {
  it("ignores other sessions and autoEvolve done", async () => {
    const a = new StubAgent();
    let settled = false;
    const p = waitTurnDone(a as any, "s1", 1000).then(() => { settled = true; });
    a.emit("event", { type: "done", sessionId: "s2" });
    a.emit("event", { type: "done", sessionId: "s1", autoEvolve: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    a.emit("event", { type: "done", sessionId: "s1" });
    await expect(p).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
  it("rejects on timeout", async () => {
    await expect(waitTurnDone(new StubAgent() as any, "s1", 10)).rejects.toThrow(/timed out/);
  });
});

describe("waitTurnDone lifecycle", () => {
  it("rejects when the session exits and releases its listeners", async () => {
    const a = new StubAgent();
    const p = waitTurnDone(a as any, "s1", 1000);
    a.emit("sessionExit", "other");
    a.emit("sessionExit", "s1");
    await expect(p).rejects.toThrow(/session exited/);
    expect(a.listenerCount("event")).toBe(0);
    expect(a.listenerCount("sessionExit")).toBe(0);
  });
});

describe("runner failure paths", () => {
  it("clears flags and listeners when the session exits mid-turn", async () => {
    const a = new StubAgent();
    a.outcome = "hang";
    const p = monoRunner(a as any, { pollMs: 1 }).run("x1", "t", { suppress: false, voice: true });
    await until(() => a.sent.length === 1);
    a.emit("sessionExit", "x1");
    await expect(p).rejects.toThrow(/session exited/);
    expect(voiceTurns.active("x1")).toBe(false);
    expect(injectedTurns.active("x1")).toBe(false);
    expect(a.aborted).toEqual([]);
    expect(a.listenerCount("event")).toBe(0);
  });
  it("aborts the session turn on timeout and clears flags", async () => {
    const a = new StubAgent();
    a.outcome = "hang";
    await expect(monoRunner(a as any, { turnTimeoutMs: 15 }).run("x2", "t", { suppress: false, voice: true })).rejects.toThrow(/timed out/);
    expect(a.aborted).toEqual(["x2"]);
    expect(voiceTurns.active("x2")).toBe(false);
    expect(injectedTurns.active("x2")).toBe(false);
  });
  it("clears flags and listeners when sendMessage throws", async () => {
    const a = new StubAgent();
    a.outcome = "throw";
    await expect(monoRunner(a as any).run("x3", "t", { suppress: false, voice: true })).rejects.toThrow(/send failed/);
    expect(voiceTurns.active("x3")).toBe(false);
    expect(injectedTurns.active("x3")).toBe(false);
    expect(a.listenerCount("event")).toBe(0);
    expect(a.listenerCount("sessionExit")).toBe(0);
    expect(a.aborted).toEqual([]);
  });
  it("node runner: lock signal aborting rejects, aborts the turn, clears flags", async () => {
    const a = new StubAgent();
    a.outcome = "hang";
    const ac = new AbortController();
    const r = nodeRunner({ agent: a as any, lock: async (_id, fn) => fn(ac.signal), refreshToken: async () => {} });
    const p = r.run("x4", "t", { suppress: false, voice: true });
    await until(() => a.sent.length === 1);
    ac.abort();
    await expect(p).rejects.toThrow(/lock lost/);
    expect(a.aborted).toEqual(["x4"]);
    expect(voiceTurns.active("x4")).toBe(false);
    expect(injectedTurns.active("x4")).toBe(false);
  });
  it("node runner propagates a turn error while holding the lock and clears flags", async () => {
    const a = new StubAgent();
    a.outcome = "error";
    let held = false;
    const r = nodeRunner({ agent: a as any, lock: async (_id, fn) => { held = true; return fn(new AbortController().signal); }, refreshToken: async () => {} });
    await expect(r.run("x5", "t", { suppress: false, voice: true })).rejects.toThrow(/boom/);
    expect(held).toBe(true);
    expect(voiceTurns.active("x5")).toBe(false);
    expect(injectedTurns.active("x5")).toBe(false);
  });
});

describe("monoRunner", () => {
  it("suppresses when asked, flags voice turns, clears the flags after", async () => {
    const a = new StubAgent();
    const r = monoRunner(a as any);
    await r.run("s1", "t", { suppress: true, voice: true });
    expect(a.suppressed).toEqual(["s1"]);
    expect(a.activeDuringSend).toEqual([true]);
    expect(voiceTurns.active("s1")).toBe(false);
    await r.run("s1", "summary", { suppress: false, voice: false });
    expect(a.activeDuringSend).toEqual([true, false]);
    // every runner turn is an injected turn, voice or not
    expect(a.injectedDuringSend).toEqual([true, true]);
    expect(injectedTurns.active("s1")).toBe(false);
  });
  it("propagates turn errors and still clears the flags", async () => {
    const a = new StubAgent();
    a.outcome = "error";
    await expect(monoRunner(a as any).run("s2", "t", { suppress: false, voice: true })).rejects.toThrow(/boom/);
    expect(voiceTurns.active("s2")).toBe(false);
    expect(injectedTurns.active("s2")).toBe(false);
  });
  it("waits for an in-flight Slack turn instead of correlating its done", async () => {
    const a = new StubAgent();
    a.inFlight = true;
    const r = monoRunner(a as any, { pollMs: 5 });
    let finished = false;
    const p = r.run("s5", "t", { suppress: false, voice: true }).then(() => { finished = true; });
    // the other turn's done must not satisfy or start the voice turn
    a.emit("event", { type: "done", sessionId: "s5" });
    await Bun.sleep(40);
    expect(a.sent).toEqual([]);
    expect(finished).toBe(false);
    expect(injectedTurns.active("s5")).toBe(false);
    a.inFlight = false;
    await until(() => a.sent.length === 1);
    await p;
    expect(a.sent).toEqual(["t"]);
  });
  it("fails the turn when a Slack turn stays in flight past maxWaitMs", async () => {
    const a = new StubAgent();
    a.inFlight = true;
    await expect(monoRunner(a as any, { pollMs: 1, maxWaitMs: 20 }).run("s6", "t", { suppress: false, voice: true })).rejects.toThrow(/session busy/);
    expect(a.sent).toEqual([]);
  });
});

describe("nodeRunner", () => {
  it("node runner retries while the lock is held, refreshes the token, runs under the lock", async () => {
    const a = new StubAgent();
    let attempts = 0;
    const order: string[] = [];
    const r = nodeRunner({
      agent: a as any,
      lock: async (_id, fn) => { attempts++; if (attempts < 3) return HELD_BY_OTHER; order.push("locked"); return fn(new AbortController().signal); },
      refreshToken: async () => { order.push("refresh"); },
      retryMs: 1,
    });
    await r.run("s3", "t", { suppress: false, voice: true });
    expect(attempts).toBe(3);
    expect(order).toEqual(["locked", "refresh"]);
    expect(a.sent).toEqual(["t"]);
    expect(a.injectedDuringSend).toEqual([true]);
  });
  it("gives up after maxWaitMs", async () => {
    const r = nodeRunner({ agent: new StubAgent() as any, lock: async () => HELD_BY_OTHER, refreshToken: async () => {}, retryMs: 1, maxWaitMs: 20 });
    await expect(r.run("s4", "t", { suppress: false, voice: true })).rejects.toThrow(/session busy/);
  });
});

describe("runners never boot a session", () => {
  it("mono refuses a turn when the session is not live", async () => {
    const a = new StubAgent();
    a.live = false;
    await expect(monoRunner(a as any).run("s1", "x", { suppress: false, voice: true })).rejects.toThrow(/not live/);
    expect(a.sent).toEqual([]);
    expect(injectedTurns.active("s1")).toBe(false);
  });
  it("node refuses a turn when the session is not live", async () => {
    const a = new StubAgent();
    a.live = false;
    const r = nodeRunner({ agent: a as any, lock: async (_id, fn) => fn(new AbortController().signal), refreshToken: async () => {} });
    await expect(r.run("s1", "x", { suppress: false, voice: true })).rejects.toThrow(/not live/);
    expect(a.sent).toEqual([]);
  });
});

describe("makeTokenKeeper", () => {
  it("refreshes the call's own token chain and binds each fresh token", async () => {
    const bound: string[] = [];
    const seen: Array<[string, string]> = [];
    const k = makeTokenKeeper({ jobId: "j1", token: "t0", refresh: async (j, t) => { seen.push([j, t]); return `${t}+`; }, bind: (t) => bound.push(t) });
    await k.refresh();
    await k.refresh();
    expect(seen).toEqual([["j1", "t0"], ["j1", "t0+"]]);
    expect(bound).toEqual(["t0+", "t0++"]);
  });
});
