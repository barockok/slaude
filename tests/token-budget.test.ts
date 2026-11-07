import { describe, expect, test } from "bun:test";
import { TokenBudget } from "../src/agent/token-budget";

const usage = (overrides: Partial<Record<string, number>> = {}) => ({
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 100,
  ...overrides,
});

const modelUsage = (contextWindow = 200_000) => ({
  "claude-sonnet-4-6": {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 500,
    cacheCreationInputTokens: 100,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow,
  },
});

describe("TokenBudget", () => {
  test("snapshot returns null before any record", () => {
    const b = new TokenBudget();
    expect(b.snapshot("s1")).toBeNull();
  });

  test("record stores usage + contextWindow from modelUsage", () => {
    const b = new TokenBudget();
    b.record("s1", { usage: usage(), modelUsage: modelUsage(1_000_000) });
    const s = b.snapshot("s1")!;
    expect(s.inputTokens).toBe(1000);
    expect(s.outputTokens).toBe(200);
    expect(s.cacheReadInputTokens).toBe(500);
    expect(s.cacheCreationInputTokens).toBe(100);
    expect(s.totalInput).toBe(1600);
    expect(s.contextWindow).toBe(1_000_000);
    expect(s.pctUsed).toBeCloseTo(0.0016);
    expect(s.remaining).toBe(1_000_000 - 1600);
  });

  test("contextWindow falls back to 200000 when modelUsage missing", () => {
    const b = new TokenBudget();
    b.record("s1", { usage: usage(), modelUsage: {} });
    expect(b.snapshot("s1")!.contextWindow).toBe(200_000);
  });

  test("constructor fallbackContextWindow overrides default", () => {
    const b = new TokenBudget({ fallbackContextWindow: 1_000_000 });
    b.record("s1", { usage: usage(), modelUsage: {} });
    expect(b.snapshot("s1")!.contextWindow).toBe(1_000_000);
  });

  test("invalid fallbackContextWindow falls back to 200000", () => {
    const b1 = new TokenBudget({ fallbackContextWindow: 0 });
    b1.record("s1", { usage: usage(), modelUsage: {} });
    expect(b1.snapshot("s1")!.contextWindow).toBe(200_000);
    const b2 = new TokenBudget({ fallbackContextWindow: NaN });
    b2.record("s1", { usage: usage(), modelUsage: {} });
    expect(b2.snapshot("s1")!.contextWindow).toBe(200_000);
    const b3 = new TokenBudget({ fallbackContextWindow: -5 });
    b3.record("s1", { usage: usage(), modelUsage: {} });
    expect(b3.snapshot("s1")!.contextWindow).toBe(200_000);
  });

  test("contextWindow picks max across multiple model entries", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage(),
      modelUsage: {
        "claude-haiku-4-5": { ...modelUsage(200_000)["claude-sonnet-4-6"]! },
        "claude-sonnet-4-6": { ...modelUsage(1_000_000)["claude-sonnet-4-6"]! },
      },
    });
    expect(b.snapshot("s1")!.contextWindow).toBe(1_000_000);
  });

  test("record overwrites prior turn", () => {
    const b = new TokenBudget();
    b.record("s1", { usage: usage({ input_tokens: 100 }), modelUsage: modelUsage() });
    b.record("s1", { usage: usage({ input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), modelUsage: modelUsage() });
    const s = b.snapshot("s1")!;
    expect(s.inputTokens).toBe(5000);
    expect(s.totalInput).toBe(5000);
  });

  test("multiple sessions tracked independently", () => {
    const b = new TokenBudget();
    b.record("a", { usage: usage({ input_tokens: 100 }), modelUsage: modelUsage() });
    b.record("b", { usage: usage({ input_tokens: 500 }), modelUsage: modelUsage() });
    expect(b.snapshot("a")!.inputTokens).toBe(100);
    expect(b.snapshot("b")!.inputTokens).toBe(500);
  });

  test("forget clears session", () => {
    const b = new TokenBudget();
    b.record("s1", { usage: usage(), modelUsage: modelUsage() });
    b.forget("s1");
    expect(b.snapshot("s1")).toBeNull();
  });

  test("forget unknown session is a no-op", () => {
    const b = new TokenBudget();
    expect(() => b.forget("ghost")).not.toThrow();
  });

  test("evaluateThreshold returns null below warn", () => {
    const b = new TokenBudget();
    b.record("s1", { usage: usage(), modelUsage: modelUsage(1_000_000) });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBeNull();
  });

  test("evaluateThreshold returns 'warn' on first crossing", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("warn");
  });

  test("evaluateThreshold suppresses repeated warn", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("warn");
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBeNull();
  });

  test("evaluateThreshold returns 'critical' when crossing higher threshold", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 185_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("critical");
  });

  test("evaluateThreshold can fire warn then critical across turns", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 165_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("warn");
    b.record("s1", {
      usage: usage({ input_tokens: 185_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("critical");
  });

  test("evaluateThreshold criticalPct=0 disables critical tier", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 195_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0)).toBe("warn");
  });

  test("evaluateThreshold without prior record returns null", () => {
    const b = new TokenBudget();
    expect(b.evaluateThreshold("ghost", 0.8, 0.9)).toBeNull();
  });

  test("forget resets threshold state so warn can re-fire", () => {
    const b = new TokenBudget();
    b.record("s1", {
      usage: usage({ input_tokens: 165_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("warn");
    b.forget("s1");
    b.record("s1", {
      usage: usage({ input_tokens: 165_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      modelUsage: modelUsage(200_000),
    });
    expect(b.evaluateThreshold("s1", 0.8, 0.9)).toBe("warn");
  });

  test("a tool loop's summed result usage does not inflate the fill: the last prompt counts", () => {
    // Three model calls in one turn, each seeing ~60k of prompt. The result's
    // usage sums them (180k input), which read as 90% (and past 100% on the
    // next turns) before; the last call's prompt is the real fill.
    const b = new TokenBudget();
    b.notePrompt("s1", { input_tokens: 10, cache_read_input_tokens: 55_000, cache_creation_input_tokens: 4_990, output_tokens: 50 });
    b.notePrompt("s1", { input_tokens: 10, cache_read_input_tokens: 59_000, cache_creation_input_tokens: 990, output_tokens: 40 });
    b.notePrompt("s1", { input_tokens: 20, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 980, output_tokens: 300 });
    b.record("s1", {
      usage: usage({ input_tokens: 40, cache_read_input_tokens: 174_000, cache_creation_input_tokens: 6_960, output_tokens: 390 }),
      modelUsage: modelUsage(200_000),
    });
    const s = b.snapshot("s1")!;
    expect(s.totalInput).toBe(61_000);
    expect(s.pctUsed).toBeCloseTo(0.305);
    expect(s.outputTokens).toBe(390);
    expect(s.pctUsed).toBeLessThanOrEqual(1);
  });

  test("notePrompt ignores an empty or missing usage, and record falls back to the result", () => {
    const b = new TokenBudget();
    b.notePrompt("s1", undefined);
    b.notePrompt("s1", { input_tokens: 0, output_tokens: 5 });
    b.record("s1", { usage: usage(), modelUsage: modelUsage() });
    expect(b.snapshot("s1")!.totalInput).toBe(1600);
  });

  test("forget drops the noted prompt too", () => {
    const b = new TokenBudget();
    b.notePrompt("s1", { input_tokens: 99_000 });
    b.forget("s1");
    b.record("s1", { usage: usage(), modelUsage: modelUsage() });
    expect(b.snapshot("s1")!.totalInput).toBe(1600);
  });

  test("record uses the noted prompt once: the next result without one falls back", () => {
    const b = new TokenBudget();
    b.notePrompt("s1", { input_tokens: 50_000 });
    b.record("s1", { usage: usage(), modelUsage: modelUsage() });
    expect(b.snapshot("s1")!.totalInput).toBe(50_000);
    b.record("s1", { usage: usage(), modelUsage: modelUsage() });
    expect(b.snapshot("s1")!.totalInput).toBe(1600);
  });
});
