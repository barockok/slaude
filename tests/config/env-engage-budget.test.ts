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
      expect(env.engageBotActPerHour()).toBe(6);
      process.env.SLAUDE_ENGAGE_BOT_ACT_PER_HOUR = "3";
      expect(env.engageBotActPerHour()).toBe(3);
      process.env.SLAUDE_ENGAGE_BOT_ACT_PER_HOUR = "junk";
      expect(env.engageBotActPerHour()).toBe(6);
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

  it("SLAUDE_ENGAGE_AGENT_USERS is a set of Slack user ids; anything else in the list is ignored", () => {
    const old = process.env.SLAUDE_ENGAGE_AGENT_USERS;
    try {
      delete process.env.SLAUDE_ENGAGE_AGENT_USERS;
      expect([...env.engageAgentUsers()]).toEqual([]);
      process.env.SLAUDE_ENGAGE_AGENT_USERS = " U0AGENTX, W0AGENTY ,junk,,lower1 ";
      expect([...env.engageAgentUsers()].sort()).toEqual(["U0AGENTX", "W0AGENTY"]);
    } finally {
      if (old === undefined) delete process.env.SLAUDE_ENGAGE_AGENT_USERS;
      else process.env.SLAUDE_ENGAGE_AGENT_USERS = old;
    }
  });
});
