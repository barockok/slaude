/**
 * What happens when a wake's ledger run ends (heartbeat wake spec, sections 6 and
 * 9): the state's failure count and next check, and the numbers caps are tuned from.
 */
import { env } from "../config/env";
import * as WakeState from "../db/heartbeat-wake-state";
import { m as metric } from "../metrics";
import { settleWake, type WakeOutcome } from "./wake-gate";

/** What the query's result said, when it reached one. */
export interface WakeStats {
  turns?: number;
  durationMs?: number;
  cap?: "usd" | "turns" | "minutes";
}

export async function settleWakeRun(a: { agentId: string; outcome: string; costUsd: number; stats?: WakeStats; now: number }): Promise<void> {
  const labels = { agent: a.agentId };
  metric.wakeCostUsd.observe(a.costUsd, labels);
  if (a.stats?.turns !== undefined) metric.wakeTurns.observe(a.stats.turns, labels);
  if (a.stats?.durationMs !== undefined) metric.wakeDurationSeconds.observe(a.stats.durationMs / 1000, labels);
  if (a.stats?.cap) metric.wakeCapHitTotal.inc({ ...labels, cap: a.stats.cap });
  const outcome: WakeOutcome = a.outcome === "ok" || a.outcome === "stopped-budget" ? a.outcome : "error";
  const state = await WakeState.get(a.agentId);
  const cfg = { slotMs: env.heartbeatMinutes() * 60_000, maxSleepMs: env.wakeMaxSleepHours() * 3_600_000 };
  const s = settleWake(state, outcome, a.now, cfg);
  await WakeState.noteSettled(a.agentId, { outcome, failures: s.failures, nextCheckAt: s.nextCheckAt }, a.now);
}
