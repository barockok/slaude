/**
 * What happens when a wake's ledger run ends (heartbeat wake spec, sections 6 and
 * 9): the state's failure count and next check, and the numbers caps are tuned from.
 */
import { env } from "../config/env";
import * as ChannelWake from "../db/channel-wake-state";
import * as WakeState from "../db/heartbeat-wake-state";
import { m as metric } from "../metrics";
import { settleWake, type WakeOutcome } from "./wake-gate";

/** What the query's result said, when it reached one. */
export interface WakeStats {
  turns?: number;
  durationMs?: number;
  cap?: "usd" | "turns" | "minutes";
}

export async function settleWakeRun(a: { agentId: string; runId?: string; scope?: string; outcome: string; costUsd: number; stats?: WakeStats; now: number }): Promise<void> {
  const labels = { agent: a.agentId };
  metric.wakeCostUsd.observe(a.costUsd, labels);
  if (a.stats?.turns !== undefined) metric.wakeTurns.observe(a.stats.turns, labels);
  if (a.stats?.durationMs !== undefined) metric.wakeDurationSeconds.observe(a.stats.durationMs / 1000, labels);
  if (a.stats?.cap) metric.wakeCapHitTotal.inc({ ...labels, cap: a.stats.cap });
  const outcome: WakeOutcome = a.outcome === "ok" || a.outcome === "stopped-budget" ? a.outcome : "error";
  const cfg = { slotMs: env.heartbeatMinutes() * 60_000, maxSleepMs: env.wakeMaxSleepHours() * 3_600_000 };
  const channel = a.runId ? await ChannelWake.channelOfRun(a.runId) : null;
  if (channel) {
    // A channel session grows, so a wake stopped by its cap will be stopped by it
    // again: unlike the agent-level wake, it backs off as a failure does.
    const s = settleWake(await ChannelWake.get(a.agentId, channel), outcome === "stopped-budget" ? "error" : outcome, a.now, cfg);
    await ChannelWake.noteSettled(a.agentId, channel, { outcome, failures: s.failures, nextCheckAt: s.nextCheckAt }, a.now);
    return;
  }
  // A channel wake's run with no row any more: a newer wake replaced it. That channel's state is the newer wake's.
  if (a.scope?.startsWith("channel:")) return;
  const state = await WakeState.get(a.agentId);
  const s = settleWake(state, outcome, a.now, cfg);
  await WakeState.noteSettled(a.agentId, { outcome, failures: s.failures, nextCheckAt: s.nextCheckAt }, a.now);
}
