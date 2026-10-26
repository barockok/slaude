/**
 * The skill-check ledger rules (spec §9.3): an open run counts its start
 * estimate toward the day's spend until finish replaces it, so concurrent
 * checks are budgeted together; a run whose finish was lost is swept as
 * `error` after an hour, keeping that estimate.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { finishSkillCheck, SKILL_CHECK_STALE_MS, startSkillCheck, sweepStaleSkillChecks, warnUnpricedModels, type SkillCheckDeps } from "../../src/background/skill-check";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import type { PriceTable } from "../../src/background/prices";

const MODEL = "claude-test-1";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 10, cache_read: 0, cache_write: 0 } };
const T0 = new Date("2026-10-26T12:00:00Z");
const DAY = "2026-10-26";
const deps = (limitUsd: number, now = T0): SkillCheckDeps => ({ priceTable: TABLE, now: () => now, budget: () => ({ limitUsd, timeZone: "UTC" }) });
const start = (limitUsd: number, now = T0) => startSkillCheck({ personaId: "default", model: MODEL, scope: "agent" }, deps(limitUsd, now));

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM background_runs");
  setAgentId("U0AGENT");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  resetAgentId();
});

describe("skill-check ledger", () => {
  test("an open run counts its estimate: two concurrent checks are budgeted together", async () => {
    // Before the nightly review: remaining − nightly floor (0.10) must cover the
    // check's floor (0.02). 0.13 leaves room for one open check, not two.
    const a = await start(0.13);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect((await Runs.get(a.runId))!.costUsd).toBeCloseTo(0.02, 9);
    expect(await start(0.13)).toEqual({ ok: false, reason: "budget" });
    // Finish replaces the estimate with the real cost, freeing the rest.
    await finishSkillCheck({ runId: a.runId, agentId: "U0AGENT", usage: { [MODEL]: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } }, outcome: "ok" }, deps(0.13));
    expect((await Runs.get(a.runId))!.costUsd).toBeCloseTo(0.001, 9);
  });

  test("a run whose finish was lost is swept as error after an hour, keeping its estimate", async () => {
    const lost = await start(1);
    if (!lost.ok) throw new Error("expected a start");
    const fresh = await start(1, new Date(T0.getTime() + SKILL_CHECK_STALE_MS - 60_000));
    if (!fresh.ok) throw new Error("expected a start");
    // A later start sweeps first.
    const later = new Date(T0.getTime() + SKILL_CHECK_STALE_MS + 1000);
    expect((await start(1, later)).ok).toBe(true);
    expect(await Runs.get(lost.runId)).toMatchObject({ outcome: "error", costUsd: 0.02 });
    expect((await Runs.get(fresh.runId))!.outcome).toBeNull();
    // The swept run's late finish is refused; the sweep is idempotent.
    expect(await finishSkillCheck({ runId: lost.runId, agentId: "U0AGENT", usage: {}, outcome: "ok" }, deps(1))).toEqual({ ok: false, reason: "not-open" });
    expect(await sweepStaleSkillChecks(later)).toBe(0);
    expect((await Runs.listBetween("U0AGENT", DAY, DAY)).filter((r) => r.outcome === null)).toHaveLength(2);
  });

  test("near-simultaneous starts with room for one estimate open at most one run", async () => {
    // 0.13 − nightly floor 0.10 leaves room for one 0.02 check, not two.
    const rs = await Promise.all([start(0.13), start(0.13), start(0.13)]);
    expect(rs.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const rows = await Runs.listBetween("U0AGENT", DAY, DAY);
    expect(rows.filter((r) => r.outcome === null).length).toBeLessThanOrEqual(1);
    expect(rows.filter((r) => r.outcome !== null).every((r) => r.outcome === "skipped-budget" && r.costUsd === 0)).toBe(true);
  });

  test("SLAUDE_MODEL unset: the check starts and is priced by the model the CLI reports", async () => {
    const r = await startSkillCheck({ personaId: "default", model: "", scope: "agent" }, deps(1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await Runs.get(r.runId))!.model).toBeNull();
    const done = await finishSkillCheck({ runId: r.runId, agentId: "U0AGENT", usage: { [MODEL]: { input: 1000, output: 100, cache_read: 0, cache_write: 0 } }, outcome: "ok" }, deps(1));
    expect(done).toEqual({ ok: true, costUsd: expect.closeTo(0.002, 9) });
    expect((await Runs.get(r.runId))!.outcome).toBe("ok");
  });

  test("the reported model labels the run when the configured one is unpriced", async () => {
    const r = await startSkillCheck({ personaId: "default", model: "claude-unknown-9", scope: "agent", reportedModel: MODEL }, deps(1));
    if (!r.ok) throw new Error("expected a start");
    expect((await Runs.get(r.runId))!.model).toBe(MODEL);
  });

  test("a reported model with no price ends the run error and keeps at least its estimate (never zero)", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await startSkillCheck({ personaId: "default", model: "", scope: "agent" }, deps(1));
      if (!r.ok) throw new Error("expected a start");
      const done = await finishSkillCheck({ runId: r.runId, agentId: "U0AGENT", usage: { "claude-unknown-9": { input: 10, output: 0, cache_read: 0, cache_write: 0 } }, outcome: "ok" }, deps(1));
      expect(done.ok).toBe(true);
      expect(await Runs.get(r.runId)).toMatchObject({ outcome: "error", costUsd: 0.02 });
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("'claude-unknown-9'");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("boot warning", () => {
  test("one loud line naming each configured model with no price; none when all are priced or unset", () => {
    warnSpy.mockClear();
    expect(warnUnpricedModels(TABLE, [MODEL, "", "claude-unknown-9", "claude-unknown-9", `${MODEL}-20260101`])).toEqual(["claude-unknown-9"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]![0]);
    expect(line).toContain("'claude-unknown-9'");
    expect(line).toContain("SLAUDE_PRICE_TABLE");
    warnSpy.mockClear();
    expect(warnUnpricedModels(TABLE, [MODEL, ""])).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
