import { describe, expect, test } from "bun:test";
import type { WakeState } from "../../src/db/heartbeat-wake-state";
import { clampNextCheck, settleWake, wakeDue, type WakeGateConfig } from "../../src/proactive/wake-gate";

const MIN = 60_000;
const H = 60 * MIN;
const NOW = 1_800_000_000_000;
const CFG: WakeGateConfig = { slotMs: 30 * MIN, maxSleepMs: 24 * H };
const state = (over: Partial<WakeState> = {}): WakeState => ({
  agentId: "A1", nextCheckAt: NOW + H, lastWakeAt: NOW - H, finishedAt: NOW - H + MIN, lastOutcome: "ok", failures: 0, checklistHash: "h1", ...over,
});

describe("wakeDue", () => {
  test("no checklist: never, whatever else holds", () => {
    expect(wakeDue(null, null, NOW, CFG)).toEqual({ due: false, reason: "no-checklist" });
    expect(wakeDue(state({ nextCheckAt: 0 }), null, NOW, CFG)).toEqual({ due: false, reason: "no-checklist" });
  });
  test("no state, or never woken: due", () => {
    expect(wakeDue(null, "h1", NOW, CFG)).toEqual({ due: true, reason: "first" });
    expect(wakeDue(state({ lastWakeAt: null }), "h1", NOW, CFG)).toEqual({ due: true, reason: "first" });
  });
  test("next check in the future and nothing changed: idle", () => {
    expect(wakeDue(state(), "h1", NOW, CFG)).toEqual({ due: false, reason: "idle" });
  });
  test("next check reached: due, at the exact instant too", () => {
    expect(wakeDue(state({ nextCheckAt: NOW }), "h1", NOW, CFG)).toEqual({ due: true, reason: "next-check" });
  });
  test("no next check stored: due", () => {
    expect(wakeDue(state({ nextCheckAt: null }), "h1", NOW, CFG)).toEqual({ due: true, reason: "next-check" });
  });
  test("a changed checklist wakes early", () => {
    expect(wakeDue(state(), "h2", NOW, CFG)).toEqual({ due: true, reason: "checklist-changed" });
  });
  test("past the longest sleep: due, even with a far next check", () => {
    expect(wakeDue(state({ lastWakeAt: NOW - 24 * H, nextCheckAt: NOW + 99 * H }), "h1", NOW, CFG)).toEqual({ due: true, reason: "max-sleep" });
  });
});

describe("clampNextCheck", () => {
  test("a time in range is kept", () => {
    expect(clampNextCheck(NOW + 3 * H, NOW, CFG)).toBe(NOW + 3 * H);
  });
  test("too soon, or in the past: one slot on, so an agent cannot run constantly", () => {
    expect(clampNextCheck(NOW + MIN, NOW, CFG)).toBe(NOW + 30 * MIN);
    expect(clampNextCheck(0, NOW, CFG)).toBe(NOW + 30 * MIN);
  });
  test("too far: the longest sleep, so an agent cannot sleep forever", () => {
    expect(clampNextCheck(NOW + 365 * 24 * H, NOW, CFG)).toBe(NOW + 24 * H);
  });
  test("missing or invalid: one slot on", () => {
    expect(clampNextCheck(null, NOW, CFG)).toBe(NOW + 30 * MIN);
    expect(clampNextCheck(undefined, NOW, CFG)).toBe(NOW + 30 * MIN);
    expect(clampNextCheck(NaN, NOW, CFG)).toBe(NOW + 30 * MIN);
  });
});

describe("settleWake", () => {
  const ran = { lastWakeAt: NOW - 10 * MIN, finishedAt: NOW - MIN, failures: 2 };
  const silent = { lastWakeAt: NOW - 10 * MIN, finishedAt: NOW - H, failures: 2 };
  test("ok and finish_round called: failures clear and its time stays", () => {
    expect(settleWake(ran, "ok", NOW, CFG)).toEqual({ failures: 0, nextCheckAt: null });
  });
  test("ok without finish_round: a failure, two slots on", () => {
    expect(settleWake(silent, "ok", NOW, CFG)).toEqual({ failures: 3, nextCheckAt: NOW + H });
    expect(settleWake(null, "ok", NOW, CFG)).toEqual({ failures: 1, nextCheckAt: NOW + H });
  });
  test("a cap stopped it: a failure, two slots on, even if it called finish_round", () => {
    expect(settleWake(ran, "stopped-budget", NOW, CFG)).toEqual({ failures: 3, nextCheckAt: NOW + H });
  });
  test("an error backs off by failure count, up to the longest sleep", () => {
    expect(settleWake({ ...ran, failures: 0 }, "error", NOW, CFG).nextCheckAt).toBe(NOW + H);
    expect(settleWake({ ...ran, failures: 1 }, "error", NOW, CFG).nextCheckAt).toBe(NOW + 2 * H);
    expect(settleWake({ ...ran, failures: 20 }, "error", NOW, CFG).nextCheckAt).toBe(NOW + 24 * H);
  });
});
