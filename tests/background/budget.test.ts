import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { canStart, localDay, PASS_FLOOR, PASS_MAX_TURNS, type BudgetConfig, type PassName } from "../../src/background/budget";
import { metrics } from "../../src/metrics";

const T = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const NOW = new Date("2026-10-26T12:00:00Z");
const CFG: BudgetConfig = { limitUsd: 1, timeZone: "UTC" };
const DAY = "2026-10-26";

async function ledger(pass: PassName, cost: number, outcome: Runs.RunOutcome) {
  const id = await Runs.start({ agentId: "a1", pass, scope: "agent", day: DAY });
  await Runs.finish(id, { tokens: T, costUsd: cost, outcome });
}

beforeEach(async () => {
  await db.run("DELETE FROM background_runs");
});

describe("localDay", () => {
  test("DST day in Europe/Berlin", () => {
    expect(localDay(new Date("2026-03-29T00:30:00Z"), "Europe/Berlin")).toBe("2026-03-29");
    expect(localDay(new Date("2026-03-28T23:30:00Z"), "Europe/Berlin")).toBe("2026-03-29");
    expect(localDay(new Date("2026-03-28T22:30:00Z"), "Europe/Berlin")).toBe("2026-03-28");
  });
  test("UTC is the date part", () => {
    expect(localDay(new Date("2026-10-26T23:59:59Z"), "UTC")).toBe("2026-10-26");
  });
});

describe("canStart", () => {
  test("floors and caps match the constraints", () => {
    expect(PASS_FLOOR["nightly-review"]).toBe(0.1);
    expect(PASS_FLOOR["skill-check"]).toBe(0.02);
    expect(PASS_MAX_TURNS["nightly-review"]).toBe(20);
    expect(PASS_MAX_TURNS["skill-review"]).toBe(12);
  });

  test("nightly refuses at spent 0.95, runs at 0.85 with the floor as estimate", async () => {
    await ledger("skill-check", 0.95, "ok");
    expect(await canStart(CFG, "a1", "nightly-review", NOW)).toEqual({ ok: false, reason: "budget" });
    await db.run("DELETE FROM background_runs");
    await ledger("skill-check", 0.85, "ok");
    const r = await canStart(CFG, "a1", "nightly-review", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.estimate).toBeCloseTo(0.1);
  });

  test("lastOkCost replaces the floor", async () => {
    await Runs.finish(await Runs.start({ agentId: "a1", pass: "nightly-review", scope: "agent", day: "2026-10-25" }), {
      tokens: T,
      costUsd: 0.4,
      outcome: "ok",
    });
    await ledger("skill-check", 0.7, "ok");
    expect(await canStart(CFG, "a1", "nightly-review", NOW)).toEqual({ ok: false, reason: "budget" });
  });

  test("a near-zero last ok run never drops the estimate below the floor", async () => {
    await Runs.finish(await Runs.start({ agentId: "a1", pass: "nightly-review", scope: "agent", day: "2026-10-25" }), {
      tokens: T,
      costUsd: 0.0001,
      outcome: "ok",
    });
    await ledger("skill-check", 0.95, "ok");
    expect(await canStart(CFG, "a1", "nightly-review", NOW)).toEqual({ ok: false, reason: "budget" });
    await db.run("DELETE FROM background_runs WHERE pass = 'skill-check'");
    const r = await canStart(CFG, "a1", "nightly-review", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.estimate).toBeCloseTo(PASS_FLOOR["nightly-review"]);
  });

  test("before the nightly ran, lower passes leave room for it", async () => {
    // 1 - 0.90 - 0.10 = 0 < 0.02 (the brief's 0.85 leaves 0.05, which would pass)
    await ledger("quiet-moment", 0.9, "ok");
    expect(await canStart(CFG, "a1", "skill-check", NOW)).toEqual({ ok: false, reason: "budget" });
    await ledger("nightly-review", 0, "ok");
    expect((await canStart(CFG, "a1", "skill-check", NOW)).ok).toBe(true);
  });

  test("a skipped-budget nightly keeps the reserve; stopped-budget lifts it", async () => {
    await ledger("quiet-moment", 0.9, "ok");
    await ledger("nightly-review", 0, "skipped-budget");
    expect((await canStart(CFG, "a1", "skill-check", NOW)).ok).toBe(false);
    await ledger("nightly-review", 0.05, "stopped-budget");
    // spent 0.95, remaining 0.05 >= 0.02
    expect((await canStart(CFG, "a1", "skill-check", NOW)).ok).toBe(true);
  });

  test("the nightly itself and lessons-upkeep are not held behind the reserve", async () => {
    await ledger("quiet-moment", 0.85, "ok");
    expect((await canStart(CFG, "a1", "lessons-upkeep", NOW)).ok).toBe(true);
  });

  test("a zero limit refuses everything priced", async () => {
    expect((await canStart({ limitUsd: 0, timeZone: "UTC" }, "a1", "skill-check", NOW)).ok).toBe(false);
  });
});

describe("metrics", () => {
  test("registered with exact names and labels", async () => {
    const { m } = await import("../../src/metrics");
    m.backgroundCostUsdTotal.inc({ agent: "a1", pass: "nightly-review" }, 0.5);
    m.backgroundRunsTotal.inc({ agent: "a1", pass: "nightly-review", outcome: "ok" });
    const out = metrics.render();
    expect(out).toContain('slaude_background_cost_usd_total{agent="a1",pass="nightly-review"} 0.5');
    expect(out).toContain('slaude_background_runs_total{agent="a1",outcome="ok",pass="nightly-review"} 1');
  });
});
