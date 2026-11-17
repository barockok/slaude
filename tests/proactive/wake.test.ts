/**
 * What every channel wake shares: its caps and how its run ends. The wake itself
 * is in channel-wake.test.ts; the agent-level wake these once tested was removed
 * in rc.14 (no scheduler path starts a `wake:` session).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as ChannelWake from "../../src/db/channel-wake-state";
import { finishSkillCheck } from "../../src/background/skill-check";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { wakeCaps } from "../../src/proactive/wake";

const AGENT = "U0AGENT";
const NOW = new Date("2026-10-26T12:00:00Z");
const H = 3_600_000;
const SOUL = "## Reporting\n- Manager: U0MANAGER\n\n## Channel C1\n### Proactive\n- Enabled: yes\n";

beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM channel_wake_state");
});
afterEach(() => __setProactiveSoulSource(null));

describe("wakeCaps", () => {
  test("the smaller of the cap and what is left", () => {
    expect(wakeCaps({ caps: () => ({ maxUsd: 1, maxTurns: 40, maxMinutes: 15 }) }, 0.4)).toEqual({ maxBudgetUsd: 0.4, maxTurns: 40, maxMinutes: 15 });
  });
  test("each cap can be off; the pool still bounds the USD", () => {
    expect(wakeCaps({ caps: () => ({ maxUsd: 0, maxTurns: 0, maxMinutes: 0 }) }, 2.5)).toEqual({ maxBudgetUsd: 2.5 });
  });
});

describe("a channel wake's run ending", () => {
  const finish = (runId: string, outcome: "ok" | "error" | "stopped-budget", usage = {}) =>
    finishSkillCheck({ runId, agentId: AGENT, usage, outcome, pass: "heartbeat-wake", stats: { turns: 3 } }, { now: () => NOW, priceTable: {} as never });

  async function started(): Promise<string> {
    const runId = await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "channel:C1", day: "2026-10-26", startedAt: NOW.getTime(), costUsd: 0.1 });
    await ChannelWake.noteStart(AGENT, "C1", "h", runId, NOW.getTime());
    return runId;
  }

  test("ok after finish_round: failures clear, its time stays", async () => {
    await ChannelWake.noteSettled(AGENT, "C1", { outcome: "error", failures: 2, nextCheckAt: null }, NOW.getTime());
    const runId = await started();
    await ChannelWake.noteFinished(AGENT, "C1", NOW.getTime() + 5 * H, NOW.getTime() + 1);
    await finish(runId, "ok");
    const st = await ChannelWake.get(AGENT, "C1");
    expect(st?.failures).toBe(0);
    expect(st?.nextCheckAt).toBe(NOW.getTime() + 5 * H);
    expect(st?.lastOutcome).toBe("ok");
  });

  test("ok without finish_round: a failure, two slots on", async () => {
    const runId = await started();
    await finish(runId, "ok");
    const st = await ChannelWake.get(AGENT, "C1");
    expect(st?.failures).toBe(1);
    expect(st?.nextCheckAt).toBeGreaterThan(NOW.getTime());
  });

  test("a wall clock with no usage is never free: it counts at the cap", async () => {
    const runId = await started();
    const r = await finish(runId, "stopped-budget");
    expect(r).toEqual({ ok: true, costUsd: 1 });
    expect((await ChannelWake.get(AGENT, "C1"))?.lastOutcome).toBe("stopped-budget");
  });
});
