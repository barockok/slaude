/**
 * The wake's gate and schedule (heartbeat wake spec, sections 3 and 6). Pure:
 * no model, no database. Whether a wake may start, and when the next one is due
 * after a wake ended, are code's decisions; the agent only proposes a time.
 */
import type { WakeState } from "../db/channel-wake-state";

export interface WakeGateConfig {
  /** One heartbeat slot. The soonest a next check can be. */
  slotMs: number;
  /** The longest an agent may sleep. Also the most a failure backs off to. */
  maxSleepMs: number;
}

export type GateResult =
  | { due: true; reason: "first" | "next-check" | "checklist-changed" | "max-sleep" }
  | { due: false; reason: "no-checklist" | "idle" };

/** Whether a wake is due now. `checklistHash` covers the channel's job (mandate and checklist page); null when it has neither. */
export function wakeDue(state: WakeState | null, checklistHash: string | null, now: number, cfg: WakeGateConfig): GateResult {
  if (checklistHash === null) return { due: false, reason: "no-checklist" };
  if (!state || state.lastWakeAt === null) return { due: true, reason: "first" };
  if (state.checklistHash !== checklistHash) return { due: true, reason: "checklist-changed" };
  if (now - state.lastWakeAt >= cfg.maxSleepMs) return { due: true, reason: "max-sleep" };
  if (state.nextCheckAt === null || state.nextCheckAt <= now) return { due: true, reason: "next-check" };
  return { due: false, reason: "idle" };
}

/** How long an agent sleeps when it did not say when to look next. */
export const DEFAULT_SLEEP_MS = 4 * 3_600_000;

/** The agent's proposal, kept inside [now + one slot, now + max sleep]. No valid proposal: a few hours on, not one slot, so forgetting is not expensive. */
export function clampNextCheck(proposed: number | null | undefined, now: number, cfg: WakeGateConfig): number {
  const soonest = now + cfg.slotMs;
  const wanted = proposed === null || proposed === undefined || !Number.isFinite(proposed) ? now + DEFAULT_SLEEP_MS : proposed;
  return Math.min(Math.max(wanted, soonest), now + cfg.maxSleepMs);
}

export type WakeOutcome = "ok" | "stopped-budget" | "error";

/**
 * What a finished wake's run does to the state (spec section 6). A null
 * `nextCheckAt` keeps the time finish_round stored. A run that ended well but
 * never called finish_round counts as a failure: it left no notes and no time.
 */
export function settleWake(
  state: Pick<WakeState, "lastWakeAt" | "finishedAt" | "failures"> | null,
  outcome: WakeOutcome,
  now: number,
  cfg: WakeGateConfig,
): { failures: number; nextCheckAt: number | null } {
  const failures = (state?.failures ?? 0) + 1;
  const twoSlots = now + 2 * cfg.slotMs;
  const finished = !!state && state.finishedAt !== null && state.lastWakeAt !== null && state.finishedAt >= state.lastWakeAt;
  if (outcome === "ok") return finished ? { failures: 0, nextCheckAt: null } : { failures, nextCheckAt: twoSlots };
  if (outcome === "stopped-budget") return { failures, nextCheckAt: twoSlots };
  return { failures, nextCheckAt: now + Math.min(cfg.slotMs * 2 ** failures, cfg.maxSleepMs) };
}
