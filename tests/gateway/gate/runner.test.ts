import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../../../src/decision/types";
import { gateRunnerFromEnv, makeGateRunner } from "../../../src/gateway/gate/runner";
import type { GateInput } from "../../../src/gateway/gate/types";
import { metrics } from "../../../src/metrics";

const engaged: GateInput = { message: "secret-message-text", recent: [], mentionsAgent: false, engaged: true, kbHitScore: null, channelTrust: "allowed" };
const mentioned: GateInput = { ...engaged, mentionsAgent: true, engaged: false };

const ans = (a: string, q: string, h: string, d: string, c = 0.95): DecisionResult => ({
  addressedToAgent: { choice: a, confidence: c },
  isQuestionOrRequest: { choice: q, confidence: c },
  agentCanHelp: { choice: h, confidence: c },
  alreadyAnswered: { choice: d, confidence: c },
});
const CHIT_CHAT = ans("no", "no", "no", "no"); // engaged → record; mentioned → record_doubt
const OPEN_REQUEST = ans("yes", "yes", "yes", "no"); // → run

type Mode = { kind: "resolve"; r: DecisionResult } | { kind: "reject" } | { kind: "hang" } | { kind: "deferred" };
function fakeAdapter(mode: Mode) {
  let calls = 0;
  let release!: (r: DecisionResult) => void;
  const a: DecisionAdapter = {
    name: "fake",
    decide: (_req: DecisionRequest) => {
      calls++;
      if (mode.kind === "resolve") return Promise.resolve(mode.r);
      if (mode.kind === "reject") return Promise.reject(new DecisionError("auth", "nope"));
      if (mode.kind === "deferred") return new Promise<DecisionResult>((res) => (release = res));
      return new Promise<DecisionResult>(() => {});
    },
  };
  return { a, calls: () => calls, release: (r: DecisionResult) => release(r) };
}

const lines: string[] = [];
const log = (l: string) => lines.push(l);
const opts = { tAct: 0.8, timeoutMs: 200, contextMessages: 8, log };

function counter(name: string, labels: Record<string, string>): number {
  const line = metrics
    .render()
    .split("\n")
    .find((l) => l.startsWith(name + "{") && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

async function until(cond: () => boolean, ms = 500) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  lines.length = 0;
});

describe("makeGateRunner", () => {
  it("off returns undefined and never calls the adapter", async () => {
    const f = fakeAdapter({ kind: "resolve", r: OPEN_REQUEST });
    let built = 0;
    const r = makeGateRunner({ ...opts, mode: "off", adapter: f.a });
    expect(r.mode).toBe("off");
    expect(await r.gate("C1:1.0", async () => (built++, engaged), "run")).toBeUndefined();
    expect(f.calls()).toBe(0);
    expect(built).toBe(0);
    expect(lines).toEqual([]);
  });

  it("on returns the policy action from the adapter's answers", async () => {
    const f = fakeAdapter({ kind: "resolve", r: CHIT_CHAT });
    const r = makeGateRunner({ ...opts, mode: "on", adapter: f.a });
    const before = counter("slaude_gate_decisions_total", { action: "record_doubt", source: "adapter", mode: "on" });
    expect(await r.gate("C1:2.0", async () => mentioned, "run")).toBe("record_doubt");
    expect(await r.gate("C1:2.1", async () => engaged, "run")).toBe("record");
    expect(f.calls()).toBe(2);
    expect(counter("slaude_gate_decisions_total", { action: "record_doubt", source: "adapter", mode: "on" })).toBe(before + 1);
    expect(lines[0]).toMatch(
      /^\[gate\] mode=on source=adapter adapter=fake action=record_doubt ms=\d+ key=C1:2\.0 a=no:0\.95 q=no:0\.95 h=no:0\.95 d=no:0\.95$/,
    );
    expect(lines.join("\n")).not.toContain("secret-message-text");
  });

  it("no adapter uses rules without a core call", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: null });
    const before = counter("slaude_decision_requests_total", {});
    expect(await r.gate("C1:3.0", async () => mentioned, "run")).toBe("run");
    expect(await r.gate("C1:3.1", async () => engaged, "run")).toBe("run");
    expect(counter("slaude_decision_requests_total", {})).toBe(before);
    expect(lines[0]).toMatch(/^\[gate\] mode=on source=rules adapter=- action=run ms=\d+ key=C1:3\.0 a=yes:1\.00 q=yes:1\.00 h=yes:1\.00 d=no:1\.00$/);
  });

  it("adapter error or timeout falls back to rules with source rules", async () => {
    const bad = fakeAdapter({ kind: "reject" });
    const r1 = makeGateRunner({ ...opts, mode: "on", adapter: bad.a });
    expect(await r1.gate("C1:4.0", async () => engaged, "run")).toBe("run");
    expect(bad.calls()).toBe(1);
    expect(lines[0]).toContain("source=rules adapter=fake action=run");

    const hang = fakeAdapter({ kind: "hang" });
    const r2 = makeGateRunner({ ...opts, timeoutMs: 30, mode: "on", adapter: hang.a });
    const t0 = Date.now();
    expect(await r2.gate("C1:4.1", async () => mentioned, "run")).toBe("run");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(lines[1]).toContain("source=rules adapter=fake action=run");
  });

  it("two deliveries of one event share one adapter call", async () => {
    const f = fakeAdapter({ kind: "resolve", r: CHIT_CHAT });
    const r = makeGateRunner({ ...opts, mode: "on", adapter: f.a });
    const [x, y] = await Promise.all([r.gate("C1:5.0", async () => engaged, "run"), r.gate("C1:5.0", async () => engaged, "run")]);
    expect(f.calls()).toBe(1);
    expect(x).toBe("record");
    expect(y).toBe("record");
    expect(lines.length).toBe(1);
  });

  it("the memo is evicted after memoTtlMs", async () => {
    const f = fakeAdapter({ kind: "resolve", r: CHIT_CHAT });
    const r = makeGateRunner({ ...opts, mode: "on", adapter: f.a, memoTtlMs: 20 });
    await r.gate("C1:6.0", async () => engaged, "run");
    await new Promise((res) => setTimeout(res, 40));
    await r.gate("C1:6.0", async () => engaged, "run");
    expect(f.calls()).toBe(2);
  });

  it("an input builder failure in on mode keeps today's path (undefined)", async () => {
    const f = fakeAdapter({ kind: "resolve", r: CHIT_CHAT });
    const r = makeGateRunner({ ...opts, mode: "on", adapter: f.a });
    expect(await r.gate("C1:7.0", async () => { throw new Error("slack down"); }, "run")).toBeUndefined();
    expect(f.calls()).toBe(0);
  });

  it("shadow never delays dispatch", async () => {
    const f = fakeAdapter({ kind: "deferred" });
    const r = makeGateRunner({ ...opts, timeoutMs: 1000, mode: "shadow", adapter: f.a });
    const before = counter("slaude_gate_shadow_disagree_total", { would: "record", actual: "run" });
    const t0 = Date.now();
    expect(await r.gate("C1:8.0", async () => engaged, "run")).toBe("run");
    expect(Date.now() - t0).toBeLessThan(20);
    await until(() => f.calls() === 1);
    expect(lines).toEqual([]);
    f.release(CHIT_CHAT);
    await until(() => lines.length === 1);
    expect(lines[0]).toContain("mode=shadow source=adapter adapter=fake action=record");
    expect(counter("slaude_gate_shadow_disagree_total", { would: "record", actual: "run" })).toBe(before + 1);
    expect(counter("slaude_gate_decisions_total", { action: "record", source: "adapter", mode: "shadow" })).toBeGreaterThan(0);
  });

  it("shadow: an agreeing decision counts no disagreement, and a failing input escapes nothing", async () => {
    const f = fakeAdapter({ kind: "resolve", r: OPEN_REQUEST });
    const r = makeGateRunner({ ...opts, mode: "shadow", adapter: f.a });
    const before = counter("slaude_gate_shadow_disagree_total", { would: "run", actual: "run" });
    expect(await r.gate("C1:9.0", async () => engaged, "run")).toBe("run");
    await until(() => lines.length === 1);
    expect(counter("slaude_gate_shadow_disagree_total", { would: "run", actual: "run" })).toBe(before);

    expect(await r.gate("C1:9.1", async () => { throw new Error("boom"); }, "run")).toBe("run");
    await until(() => lines.length === 2);
    expect(lines[1]).toContain("[gate] mode=shadow input failed key=C1:9.1");
  });
});

describe("gateRunnerFromEnv", () => {
  const saved = process.env.SLAUDE_DECISION_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.SLAUDE_DECISION_CONFIG;
    else process.env.SLAUDE_DECISION_CONFIG = saved;
  });
  const deps = { resolveSecret: async () => { throw new Error("unresolvable"); } };

  it("unset config → mode off; invalid JSON → mode off, one log line without the raw value", async () => {
    delete process.env.SLAUDE_DECISION_CONFIG;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await gateRunnerFromEnv(deps)).mode).toBe("off");
      expect(warn).not.toHaveBeenCalled();

      process.env.SLAUDE_DECISION_CONFIG = '{"gate": {"mode": "on"}, "apiKey": "raw-secret-value';
      const r = await gateRunnerFromEnv(deps);
      expect(r.mode).toBe("off");
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toContain("SLAUDE_DECISION_CONFIG");
      expect(msg).not.toContain("raw-secret-value");
    } finally {
      warn.mockRestore();
    }
  });

  it("valid config with an unresolvable secret → configured mode, rules source", async () => {
    process.env.SLAUDE_DECISION_CONFIG = JSON.stringify({
      timeoutMs: 100,
      gate: { mode: "on", contextMessages: 5 },
      adapter: { type: "jev", apiKey: "env://PERSONA_TYPESAFE_API_KEY" },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const info = spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = await gateRunnerFromEnv(deps);
      expect(r.mode).toBe("on");
      expect(r.contextMessages).toBe(5);
      expect(await r.gate("C1:10.0", async () => mentioned, "run")).toBe("run");
      const gateLine = info.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[gate]"));
      expect(gateLine).toContain("source=rules adapter=-");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
