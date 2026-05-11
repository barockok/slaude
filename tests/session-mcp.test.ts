import { describe, expect, test } from "bun:test";
import {
  createSessionMcp,
  sessionHandlers,
  SESSION_MCP_NAME,
} from "../src/agent/session-mcp";
import type { UsageSnapshot } from "../src/agent/token-budget";

const snap = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  inputTokens: 50_000,
  outputTokens: 1_000,
  cacheReadInputTokens: 100_000,
  cacheCreationInputTokens: 5_000,
  totalInput: 155_000,
  contextWindow: 200_000,
  pctUsed: 0.775,
  remaining: 45_000,
  ...overrides,
});

describe("sessionHandlers.token_budget", () => {
  test("returns a 'no usage yet' message when nothing recorded", async () => {
    const r = await sessionHandlers.token_budget({
      getSnapshot: () => null,
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("no usage recorded");
  });

  test("returns JSON snapshot when usage available", async () => {
    const s = snap();
    const r = await sessionHandlers.token_budget({
      getSnapshot: () => s,
    });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.input_tokens).toBe(50_000);
    expect(parsed.output_tokens).toBe(1_000);
    expect(parsed.cache_read_input_tokens).toBe(100_000);
    expect(parsed.cache_creation_input_tokens).toBe(5_000);
    expect(parsed.total_input).toBe(155_000);
    expect(parsed.context_window).toBe(200_000);
    expect(parsed.pct_used).toBeCloseTo(0.775);
    expect(parsed.remaining).toBe(45_000);
  });

  test("includes percent_used_human field rounded to 1dp", async () => {
    const r = await sessionHandlers.token_budget({
      getSnapshot: () => snap({ pctUsed: 0.7752 }),
    });
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.percent_used_human).toBe("77.5%");
  });
});

describe("createSessionMcp", () => {
  test("returns SDK mcp config under expected name", () => {
    const cfg = createSessionMcp({ getSnapshot: () => null });
    expect(cfg.name).toBe(SESSION_MCP_NAME);
    expect((cfg as any).type).toBe("sdk");
    expect((cfg as any).instance).toBeDefined();
  });
});
