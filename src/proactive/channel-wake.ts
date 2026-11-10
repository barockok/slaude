/**
 * A channel session's wake (channel session spec, Wakes): the agent-level wake's
 * gate, budget and failure handling, per channel, in that channel's own session.
 * An agent runs one wake at a time across its channels: a channel due while
 * another wake runs goes at the next slot, earliest due first.
 */
import { spendLeft } from "../background/budget";
import { budgetConfigFor } from "../background/config";
import { renderPassPrompt } from "../background/prompts";
import type { AgentGroup } from "../background/scheduler";
import { finishSkillCheck, startSkillCheck } from "../background/skill-check";
import * as Runs from "../db/background-runs";
import * as ChannelWake from "../db/channel-wake-state";
import { channelSessionKey } from "../gateway/core/channel-session";
import { m as metric } from "../metrics";
import { personaDefaultModel } from "../persona/registry";
import { channelSessionWakes } from "../soul/proactive";
import { line, OUT_OF_BUDGET_TEXT, tellManagerOnce } from "./heartbeat";
import { loadRules } from "./rules";
import { checklistHash, FAILURES_WORTH_A_NOTICE, wakeCaps, wakeGateConfig, WakeTargetBusyError, type WakeDeps, type WakeResult } from "./wake";
import { wakeDue } from "./wake-gate";

/** A channel wake's ledger scope: how settling tells its run from an agent-level one after the channel's row moved on. */
export const channelWakeScope = (channelId: string): string => `channel:${channelId}`;

/** One wake across this agent's channel sessions, if one is due. Never throws for a transport failure. */
export async function runChannelWakes(r: AgentGroup & { slot: string; now: Date; signal?: AbortSignal }, deps: WakeDeps): Promise<WakeResult> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat-wake`;
  if (r.signal?.aborted) return "idle";
  const channels = (deps.channelsOn ?? channelSessionWakes)(r.personaId);
  if (channels.length === 0) return "idle";
  const count = (result: string) => metric.wakeGateTotal.inc({ agent: r.agentId, result });
  const now = r.now.getTime();
  const managerId = deps.managerId(r.personaId);
  const app = await deps.app(r.personaId).catch(() => undefined);
  const notice = { managerId, app, post: deps.post, at: r.now, tag };
  const m = deps.mandates(r.personaId, channels);
  const cfg = (deps.gate ?? wakeGateConfig)();

  const due: { channel: string; mandate: string; hash: string; at: number; reason: string; state: ChannelWake.ChannelWakeState | null }[] = [];
  for (const channel of channels) {
    const mandate = m.channels[channel] ?? m.global;
    const hash = mandate ? checklistHash(mandate) : null;
    const state = await ChannelWake.get(r.agentId, channel);
    if (state && state.failures >= FAILURES_WORTH_A_NOTICE) {
      if (state.lastOutcome === "stopped-budget") {
        await tellManagerOnce(r, `wake-budget:${channel}`, `My last ${state.failures} recurring checks in <#${channel}> ran out of their per-run budget. This channel's session may be too large for the per-run cap. \`/new\` in the channel starts it over.`, notice);
      } else {
        await tellManagerOnce(r, `wake-failures:${channel}`, `My last ${state.failures} recurring checks in <#${channel}> failed (last result: ${line(state.lastOutcome) || "unknown"}). Please take a look.`, notice);
      }
    }
    const gate = wakeDue(state, hash, now, cfg);
    count(gate.reason);
    if (gate.due) due.push({ channel, mandate: mandate!, hash: hash!, at: state?.nextCheckAt ?? 0, reason: gate.reason, state });
  }
  if (due.length === 0) return "idle";
  due.sort((a, b) => a.at - b.at || a.channel.localeCompare(b.channel));

  // One at a time across the agent, either kind. The stale sweep ends a run that lost its finish.
  const open = await Runs.listOpen("heartbeat-wake", now + 1);
  if (open.some((o) => o.agentId === r.agentId)) {
    count("busy");
    console.log(`${tag}: a wake is still running; not starting another`);
    return "busy";
  }
  if (!app?.teamId || !managerId) {
    console.warn(`${tag}: no Slack team or manager is known; cannot wake`);
    return "no-team";
  }

  const named = r.personaId !== "default" ? r.personaId : undefined;
  for (const d of due) {
    const target = { teamId: app.teamId, managerId, channelId: d.channel, threadTs: channelSessionKey(d.channel), personaId: r.personaId, agentId: r.agentId, appId: app.apiAppId };
    // A wake waits until a running turn ends: this channel stays due, and the
    // next channel may go. Checked before any run opens, so nothing is spent.
    if (await deps.transport.busy?.(target).catch(() => true)) {
      count("busy");
      console.log(`${tag}: <#${d.channel}> has a turn running; its wake waits`);
      continue;
    }
    const left = await (deps.left ?? ((p, a, at) => spendLeft(budgetConfigFor(p), a, "heartbeat-wake", at)))(r.personaId, r.agentId, r.now);
    const run = await (deps.startRun ?? startSkillCheck)({ personaId: r.personaId, model: personaDefaultModel(named), scope: channelWakeScope(d.channel), pass: "heartbeat-wake" });
    if (!run.ok) {
      if (run.reason === "budget") {
        count("no-budget");
        await tellManagerOnce(r, "budget", OUT_OF_BUDGET_TEXT, notice);
        return "no-budget";
      }
      return "no-model";
    }
    try {
      await ChannelWake.noteStart(r.agentId, d.channel, d.hash, run.runId, now);
      const rules = await loadRules(r.agentId, deps.call);
      const envelope = renderPassPrompt("channel-wake", {
        NOW: new Date(now).toISOString(),
        TIME_ZONE: r.timeZone,
        MANDATE: d.mandate,
        MANAGER: managerId,
        RULES: rules.map((x) => `- ${line(x.slug)} · ${line(x.kind)} · ${line(x.scope)} · ${x.level}`).join("\n") || "(none)",
      });
      await deps.transport.dispatch(target, envelope, { runId: run.runId, agentId: run.agentId }, wakeCaps(deps, left));
      console.log(`${tag}: woke in <#${d.channel}> (${d.reason})`);
      return "woke";
    } catch (e) {
      if (e instanceof WakeTargetBusyError) {
        // A turn started since `busy`: the wake never ran. The state goes back, so
        // settling finds no channel for this run, and the channel stays due.
        await ChannelWake.undoStart(r.agentId, d.channel, run.runId, d.state, now).catch(() => {});
        await finishSkillCheck({ runId: run.runId, agentId: run.agentId, usage: {}, outcome: "ok", pass: "heartbeat-wake" }).catch(() => {});
        count("busy");
        console.log(`${tag}: <#${d.channel}> started a turn first; its wake waits`);
        continue;
      }
      console.error(`${tag}: could not start in <#${d.channel}>: ${e instanceof Error ? e.message : String(e)}`);
      await finishSkillCheck({ runId: run.runId, agentId: run.agentId, usage: {}, outcome: "error", pass: "heartbeat-wake" }).catch(() => {});
      return "failed";
    }
  }
  return "busy";
}
