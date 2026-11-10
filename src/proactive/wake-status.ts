/**
 * `/heartbeat status`: what the agent's recurring checks are doing, for its
 * manager. Today's refusals, one line per proactive channel, and the last 7
 * days' wakes, so caps can be set from what wakes really take.
 */
import { localDay, PROACTIVE_PASSES, type BudgetConfig } from "../background/budget";
import * as Runs from "../db/background-runs";
import * as ChannelWake from "../db/channel-wake-state";
import { channelSessionWakes, wakesSwitchedOff } from "../soul/proactive";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const when = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC");
const WEEK_MS = 7 * 86_400_000;

export async function wakeStatusText(a: { personaId: string; agentId: string; managerId: string | null; budget: BudgetConfig; now: Date }): Promise<string> {
  const today = localDay(a.now, a.budget.timeZone);
  const runs = await Runs.listBetween(a.agentId, localDay(new Date(a.now.getTime() - WEEK_MS), a.budget.timeZone), today);
  const proactive = (p: string) => (PROACTIVE_PASSES as readonly string[]).includes(p);
  const todays = runs.filter((r) => r.day === today);
  const spent = (f: (p: string) => boolean) => todays.filter((r) => f(r.pass)).reduce((s, r) => s + r.costUsd, 0);
  const split = a.budget.proactiveLimitUsd !== undefined && a.budget.proactiveLimitUsd !== null;
  const lines: string[] = ["*Recurring checks*"];
  lines.push(
    split
      ? `Today: proactive ${usd(spent(proactive))} of ${usd(a.budget.proactiveLimitUsd!)}, learning ${usd(spent((p) => !proactive(p)))} of ${usd(a.budget.limitUsd)}`
      : `Today: ${usd(spent(() => true))} of ${usd(a.budget.limitUsd)} (one shared budget)`,
  );
  const skipped = todays.filter((r) => r.outcome === "skipped-budget" && proactive(r.pass)).length;
  if (skipped) lines.push(`Refused by budget today: ${skipped}`);
  const channels = channelSessionWakes(a.personaId);
  if (wakesSwitchedOff(a.personaId)) lines.push("Wakes are off: this agent's soul says `Wake: no`.");
  else if (channels.length === 0) lines.push("No channel has proactive on.");
  else if (!a.managerId) lines.push("No wakes run: this agent has no manager.");
  for (const channel of channels) {
    const s = await ChannelWake.get(a.agentId, channel);
    lines.push(s ? `<#${channel}>: last wake ${when(s.lastWakeAt)} (${s.lastOutcome ?? "running"}); next check: ${when(s.nextCheckAt)}; failures in a row: ${s.failures}` : `<#${channel}>: no wake yet`);
  }
  const wakes = runs.filter((r) => r.pass === "heartbeat-wake" && r.outcome && r.outcome !== "skipped-budget");
  if (wakes.length) {
    const costs = wakes.map((r) => r.costUsd).sort((x, y) => x - y);
    const stopped = wakes.filter((r) => r.outcome === "stopped-budget").length;
    lines.push(`Last 7 days: ${wakes.length} wakes, median ${usd(costs[Math.floor(costs.length / 2)]!)}, highest ${usd(costs[costs.length - 1]!)}, ${stopped} stopped by a cap`);
  }
  return lines.join("\n");
}
