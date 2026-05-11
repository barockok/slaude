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
});
