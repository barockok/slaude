import { describe, expect, it } from "bun:test";
import { env } from "../../src/config/env";

const KEYS = ["SLAUDE_ENGAGE_DAILY_BUDGET", "SLAUDE_ENGAGE_MINUTE_CEILING", "SLAUDE_ENGAGE_ACT_PER_HOUR", "SLAUDE_ENGAGE_BOT_ACT_PER_HOUR"] as const;

describe("engage classifier budgets", () => {
  it("default high enough for every candidate to be asked, and read overrides", () => {
    const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      expect(env.engageDailyBudget()).toBe(2000);
      expect(env.engageMinuteCeiling()).toBe(20);
      expect(env.engageActPerHour()).toBe(12);
      process.env.SLAUDE_ENGAGE_DAILY_BUDGET = "300";
      process.env.SLAUDE_ENGAGE_MINUTE_CEILING = "junk";
      expect(env.engageDailyBudget()).toBe(300);
      expect(env.engageMinuteCeiling()).toBe(20);
    } finally {
      for (const k of KEYS) {
        if (old[k] === undefined) delete process.env[k];
        else process.env[k] = old[k];
      }
    }
  });
});
