import { describe, expect, it, spyOn } from "bun:test";
import { DecisionError, type DecisionAdapter, type DecisionRequest } from "../../src/decision/types";
import { adapterFromConfig, decide, registerAdapter } from "../../src/decision/registry";
import { parseDecisionConfig } from "../../src/decision/config";

const req: DecisionRequest = {
  state: { msg: "hi" },
  questions: { q1: { instructions: "pick", options: { yes: "y", no: "n" } } },
};
const deps = { resolveSecret: async (r: string) => r };
const fake = (result: unknown): DecisionAdapter => ({ name: "fake", decide: async () => result as never });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof DecisionError ? e.kind : "other";
  }
  return "resolved";
}

describe("decide", () => {
  it("returns the adapter's validated answers", async () => {
    const r = await decide(fake({ q1: { choice: "yes", confidence: 0.9 } }), req, 100);
    expect(r.q1).toEqual({ choice: "yes", confidence: 0.9 });
  });
  it("answers outside the declared options are rejected", async () => {
    expect(await kindOf(decide(fake({ q1: { choice: "maybe", confidence: 0.9 } }), req, 100))).toBe("bad_output");
  });
  it("a missing question or out-of-range confidence is rejected", async () => {
    expect(await kindOf(decide(fake({}), req, 100))).toBe("bad_output");
    expect(await kindOf(decide(fake({ q1: { choice: "yes", confidence: 1.5 } }), req, 100))).toBe("bad_output");
    expect(await kindOf(decide(fake({ q1: { choice: "yes", confidence: -0.1 } }), req, 100))).toBe("bad_output");
    expect(await kindOf(decide(fake({ q1: { choice: "yes", confidence: 1 }, extra: { choice: "yes", confidence: 1 } }), req, 100))).toBe("bad_output");
  });
  it("decide times out", async () => {
    const hang: DecisionAdapter = { name: "hang", decide: () => new Promise(() => {}) };
    const t0 = Date.now();
    expect(await kindOf(decide(hang, req, 30))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(150);
  });
  it("adapter errors propagate as DecisionError", async () => {
    const bad: DecisionAdapter = { name: "bad", decide: async () => { throw new DecisionError("auth", "nope"); } };
    expect(await kindOf(decide(bad, req, 100))).toBe("auth");
    const raw: DecisionAdapter = { name: "raw", decide: async () => { throw new Error("boom"); } };
    expect(await kindOf(decide(raw, req, 100))).toBe("transport");
  });
});

describe("adapterFromConfig", () => {
  it("absent → null; unknown type → null; registered → that adapter; factory throw → null", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await adapterFromConfig(undefined, deps)).toBeNull();
    expect(await adapterFromConfig(null, deps)).toBeNull();
    expect(await adapterFromConfig({ type: "nope-type" }, deps)).toBeNull();
    const a = fake({});
    registerAdapter("t-ok", async () => a);
    expect(await adapterFromConfig({ type: "t-ok" }, deps)).toBe(a);
    registerAdapter("t-throw", async () => { throw new Error("secret-value-xyz"); });
    expect(await adapterFromConfig({ type: "t-throw", apiKey: "secret-value-xyz" }, deps)).toBeNull();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("secret-value-xyz");
    warn.mockRestore();
  });
});

describe("parseDecisionConfig", () => {
  it("unset or {} → gate off, no adapter, timeoutMs 800", () => {
    for (const raw of [undefined, "", "{}"]) {
      const r = parseDecisionConfig(raw);
      expect(r.error).toBeUndefined();
      expect(r.config).toEqual({ timeoutMs: 800, gate: { mode: "off", tAct: 0.8, contextMessages: 8 }, adapter: null });
    }
  });
  it("valid config parses", () => {
    const r = parseDecisionConfig('{"timeoutMs":500,"gate":{"mode":"shadow","tAct":0.7,"contextMessages":4},"adapter":{"type":"x","k":1}}');
    expect(r.error).toBeUndefined();
    expect(r.config.gate.mode).toBe("shadow");
    expect(r.config.adapter).toEqual({ type: "x", k: 1 });
  });
  it("invalid JSON or out-of-range field → all-default config and an error naming the field, not its value", () => {
    const r = parseDecisionConfig('{"gate":{"tAct":2}}');
    expect(r.config.gate.mode).toBe("off");
    expect(r.error).toContain("gate.tAct");
    expect(r.error).not.toContain("2");
    const j = parseDecisionConfig("{not json");
    expect(j.config.gate.mode).toBe("off");
    expect(j.config.adapter).toBeNull();
    expect(j.error).toBeTruthy();
  });
  it("unknown top-level key is rejected", () => {
    const r = parseDecisionConfig('{"bogus":1,"gate":{"mode":"on"}}');
    expect(r.error).toBeTruthy();
    expect(r.config.gate.mode).toBe("off");
  });
});
