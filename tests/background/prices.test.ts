import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costUsd, DEFAULT_PRICE_TABLE, loadPriceTable, tokensFromUsage, unpricedModels, type PriceTable } from "../../src/background/prices";

const T: PriceTable = { m: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };

describe("costUsd", () => {
  test("sums every kind per million tokens", () => {
    const c = costUsd(T, "m", { input: 1_000_000, output: 100_000, cache_read: 2_000_000, cache_write: 0 });
    expect(Math.abs((c as number) - (3 + 1.5 + 0.6))).toBeLessThan(1e-9);
  });
  test("cache_write is priced", () => {
    const c = costUsd(T, "m", { input: 0, output: 0, cache_read: 0, cache_write: 1_000_000 });
    expect(c).toBeCloseTo(3.75, 9);
  });
  test("unknown model is null, never zero", () => {
    expect(costUsd(T, "nope", { input: 1, output: 1, cache_read: 1, cache_write: 1 })).toBeNull();
    expect(costUsd(T, "toString", { input: 1, output: 1, cache_read: 1, cache_write: 1 })).toBeNull();
  });
  test("strips the anthropic/ provider prefix only, no fuzzy match", () => {
    const z = { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
    expect(costUsd(T, "anthropic/m", z)).toBe(3);
    expect(costUsd(T, "openrouter/m", z)).toBeNull();
    expect(costUsd(T, "mm", z)).toBeNull();
    expect(costUsd(DEFAULT_PRICE_TABLE, "anthropic/claude-sonnet-4-6", z)).toBe(3);
  });
  test("a trailing -YYYYMMDD date suffix is stripped, exactly (dated ids such as the CLI's helper model)", () => {
    const z = { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
    expect(costUsd(T, "m-20250101", z)).toBe(3);
    expect(costUsd(T, "anthropic/m-20250101", z)).toBe(3);
    expect(costUsd(DEFAULT_PRICE_TABLE, "claude-haiku-4-5-20251001", z)).toBe(1);
    // An exact entry wins over the stripped one.
    expect(costUsd({ ...T, "m-20250101": { input: 7, output: 0, cache_read: 0, cache_write: 0 } }, "m-20250101", z)).toBe(7);
    // Not a date suffix: no match.
    for (const id of ["m-2025010", "m-202501011", "m20250101", "m-20250101-x", "m-v20250101"]) expect(costUsd(T, id, z)).toBeNull();
  });
});

describe("unpricedModels", () => {
  test("names each configured model the table has no price for, deduplicated; unset is not listed", () => {
    expect(unpricedModels(T, ["m", "", "anthropic/m-20250101", "x", "x", "y"])).toEqual(["x", "y"]);
  });
});

describe("loadPriceTable", () => {
  const custom = { x: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } };
  test("unset gives defaults and no errors", () => {
    expect(loadPriceTable(undefined)).toEqual({ table: DEFAULT_PRICE_TABLE, errors: [] });
  });
  test("inline JSON loads", () => {
    expect(loadPriceTable(JSON.stringify(custom))).toEqual({ table: custom, errors: [] });
  });
  test("file path loads", () => {
    const f = join(mkdtempSync(join(tmpdir(), "prices-")), "p.json");
    writeFileSync(f, JSON.stringify(custom));
    expect(loadPriceTable(f)).toEqual({ table: custom, errors: [] });
  });
  test("bad JSON: defaults and an error without content", () => {
    const r = loadPriceTable('{"secret-model": oops');
    expect(r.table).toBe(DEFAULT_PRICE_TABLE);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("SLAUDE_PRICE_TABLE");
    expect(r.errors[0]).not.toContain("secret-model");
  });
  test("missing file: error names the variable, not the path", () => {
    const r = loadPriceTable("/nonexistent/dir/prices.json");
    expect(r.table).toBe(DEFAULT_PRICE_TABLE);
    expect(r.errors[0]).not.toContain("/nonexistent");
  });
  test("bad shape names paths, not values", () => {
    const r = loadPriceTable(JSON.stringify({ x: { input: "9.99", output: 2, cache_read: 1 } }));
    expect(r.table).toBe(DEFAULT_PRICE_TABLE);
    expect(r.errors[0]).toContain("x.input");
    expect(r.errors[0]).toContain("x.cache_write");
    expect(r.errors[0]).not.toContain("9.99");
  });
  test("negative price is rejected", () => {
    const r = loadPriceTable(JSON.stringify({ x: { input: -1, output: 2, cache_read: 1, cache_write: 1 } }));
    expect(r.errors[0]).toContain("x.input");
  });
});

describe("tokensFromUsage", () => {
  test("maps every field", () => {
    expect(
      tokensFromUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
    ).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
  });
  test("missing fields count as 0", () => {
    expect(tokensFromUsage({ input_tokens: 5 } as never)).toEqual({ input: 5, output: 0, cache_read: 0, cache_write: 0 });
  });
});

describe("DEFAULT_PRICE_TABLE", () => {
  test("every model has all four kinds, positive", () => {
    expect(Object.keys(DEFAULT_PRICE_TABLE).length).toBeGreaterThan(0);
    for (const row of Object.values(DEFAULT_PRICE_TABLE)) {
      for (const k of ["input", "output", "cache_read", "cache_write"] as const) {
        expect(typeof row[k]).toBe("number");
        expect(row[k]).toBeGreaterThan(0);
      }
    }
  });
});

describe("env accessors", () => {
  test("backgroundBudgetUsd defaults to 1 and rejects junk", async () => {
    const { env } = await import("../../src/config/env");
    const prev = process.env.SLAUDE_BACKGROUND_BUDGET_USD;
    try {
      delete process.env.SLAUDE_BACKGROUND_BUDGET_USD;
      expect(env.backgroundBudgetUsd()).toBe(1);
      process.env.SLAUDE_BACKGROUND_BUDGET_USD = "2.5";
      expect(env.backgroundBudgetUsd()).toBe(2.5);
      process.env.SLAUDE_BACKGROUND_BUDGET_USD = "0";
      expect(env.backgroundBudgetUsd()).toBe(0);
      for (const bad of ["abc", "-1", ""]) {
        process.env.SLAUDE_BACKGROUND_BUDGET_USD = bad;
        expect(env.backgroundBudgetUsd()).toBe(1);
      }
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_BACKGROUND_BUDGET_USD;
      else process.env.SLAUDE_BACKGROUND_BUDGET_USD = prev;
    }
  });
});
