/**
 * The skill-check ledger rules (spec §9.3): an open run counts its start
 * estimate toward the day's spend until finish replaces it, so concurrent
 * checks are budgeted together; a run whose finish was lost is swept as
 * `error` after an hour, keeping that estimate.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { finishSkillCheck, SKILL_CHECK_STALE_MS, startSkillCheck, sweepStaleSkillChecks, type SkillCheckDeps } from "../../src/background/skill-check";
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
});
