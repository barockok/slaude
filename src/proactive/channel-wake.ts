/**
 * A channel's wake (channel session spec, Wakes): the gate, the budget and the
 * failure handling, per channel, in that channel's own session. An agent runs
 * one wake at a time across its channels: a channel due while another wake runs
 * goes at the next slot, earliest due first.
 *
 * Each proactive channel has a checklist page of its own (channelChecklistSlug).
 * Its body goes into the prompt as data, and the hash that decides a wake is due
 * covers the mandate plus that page, so editing the page wakes the channel.
 */
import { spendLeft } from "../background/budget";
import { budgetConfigFor } from "../background/config";
import { renderPassPrompt } from "../background/prompts";
import type { AgentGroup } from "../background/scheduler";
import { finishSkillCheck, startSkillCheck } from "../background/skill-check";
import { claimedAt, claimSlot } from "../db/background-slots";
import * as Runs from "../db/background-runs";
import * as ChannelWake from "../db/channel-wake-state";
import { channelSessionKey } from "../gateway/core/channel-session";
import type { AppRef } from "../gateway/core/transport";
import { composePage, readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull } from "../knowledge/memory-trail";
import { m as metric } from "../metrics";
import { personaDefaultModel } from "../persona/registry";
import { channelSessionWakes } from "../soul/proactive";
import { agentPageBody, agentScope, channelChecklistSlug, HEARTBEAT_SLUG, line, OUT_OF_BUDGET_TEXT, tellManagerOnce } from "./heartbeat";
import { loadRules } from "./rules";
import { checklistHash, FAILURES_WORTH_A_NOTICE, wakeCaps, wakeGateConfig, WakeTargetBusyError, type WakeDeps, type WakeResult } from "./wake";
import { wakeDue } from "./wake-gate";

/** A channel wake's ledger scope: how settling tells its run from another after the channel's row moved on. */
export const channelWakeScope = (channelId: string): string => `channel:${channelId}`;

type Run = AgentGroup & { slot: string; now: Date; signal?: AbortSignal };

/** The ledger pass name of a channel's one-time checklist copy (background_slots). */
const CHECKLIST_MIGRATION_PASS = "heartbeat-checklist-migration";
const migrationWarned = new Set<string>();

/**
 * Before the first wake of this release: an agent's old per-agent `self/heartbeat`
 * page becomes its one proactive channel's page, once. The old page stays. With
 * several proactive channels it is not copied, because which line belongs where
 * is the agent's call: warned once per process. A failure is logged; the next
 * start tries again.
 */
async function migrateChecklist(r: Run, channels: readonly string[], deps: WakeDeps): Promise<void> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat-wake`;
  try {
    const legacy = await agentPageBody(r.agentId, deps.call, HEARTBEAT_SLUG);
    if (!legacy) return;
    const scope = agentScope(r.agentId);
    const missing: string[] = [];
    for (const c of channels) {
      if (!readPageRecord(await getPageOrNull(deps.call, channelChecklistSlug(c), scope))) missing.push(c);
    }
    if (missing.length === 0) return;
    if (channels.length > 1) {
      if (!migrationWarned.has(r.agentId)) {
        migrationWarned.add(r.agentId);
        console.warn(`${tag}: its ${HEARTBEAT_SLUG} page was not copied, since it has ${channels.length} proactive channels. Each needs its own checklist page (${missing.map(channelChecklistSlug).join(", ")}).`);
      }
      return;
    }
    const channel = channels[0]!;
    if ((await claimedAt(r.agentId, CHECKLIST_MIGRATION_PASS, channel)) !== null) return;
    const slug = channelChecklistSlug(channel);
    const page = composePage({ slug, content: legacy, type: "heartbeat" }, r.now);
    if ("error" in page) throw new Error(page.error);
    await deps.call("put_page", { slug, content: page.content }, scope);
    await claimSlot(r.agentId, CHECKLIST_MIGRATION_PASS, channel, r.now.getTime());
    console.log(`${tag}: copied ${HEARTBEAT_SLUG} to ${slug}`);
  } catch (e) {
    console.warn(`${tag}: could not check the old checklist page: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One channel's job: its mandate plus its checklist page. `hash` is null with neither. */
async function channelJob(r: Run, channel: string, mandate: string, deps: WakeDeps): Promise<{ page: string; hash: string | null }> {
  const page = await agentPageBody(r.agentId, deps.call, channelChecklistSlug(channel));
  const job = [mandate, page].filter(Boolean).join("\n");
  return { page, hash: job ? checklistHash(job) : null };
}

type Job = { channel: string; mandate: string; page: string; hash: string; state: ChannelWake.ChannelWakeState | null };

/** Start one channel's wake. "busy" means nothing ran and nothing changed: the channel stays as it was. */
async function startChannelWake(r: Run, d: Job, managerId: string, app: AppRef, reason: string, deps: WakeDeps, notice: Parameters<typeof tellManagerOnce>[3]): Promise<WakeResult> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat-wake`;
  const count = (result: string) => metric.wakeGateTotal.inc({ agent: r.agentId, result });
  const now = r.now.getTime();
  const named = r.personaId !== "default" ? r.personaId : undefined;
  const target = { teamId: app.teamId!, managerId, channelId: d.channel, threadTs: channelSessionKey(d.channel), personaId: r.personaId, agentId: r.agentId, appId: app.apiAppId };
  // A wake waits until a running turn ends. Checked before any run opens, so nothing is spent.
  if (await deps.transport.busy?.(target).catch(() => true)) {
    count("busy");
    console.log(`${tag}: <#${d.channel}> has a turn running; its wake waits`);
    return "busy";
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
      MANDATE: d.mandate || "(none set: your checklist below is your job)",
      MANAGER: managerId,
      CHECKLIST_SLUG: channelChecklistSlug(d.channel),
      CHECKLIST: d.page.replace(/<\/?checklist>/gi, "") || "(none yet)",
      RULES: rules.map((x) => `- ${line(x.slug)} · ${line(x.kind)} · ${line(x.scope)} · ${x.level}`).join("\n") || "(none)",
    });
    await deps.transport.dispatch(target, envelope, { runId: run.runId, agentId: run.agentId }, wakeCaps(deps, left));
    console.log(`${tag}: woke in <#${d.channel}> (${reason})`);
    return "woke";
  } catch (e) {
    if (e instanceof WakeTargetBusyError) {
      // A turn started since `busy`: the wake never ran. The state goes back, so
      // settling finds no channel for this run, and the channel stays due.
      await ChannelWake.undoStart(r.agentId, d.channel, run.runId, d.state, now).catch(() => {});
      await finishSkillCheck({ runId: run.runId, agentId: run.agentId, usage: {}, outcome: "ok", pass: "heartbeat-wake" }).catch(() => {});
      count("busy");
      console.log(`${tag}: <#${d.channel}> started a turn first; its wake waits`);
      return "busy";
    }
    console.error(`${tag}: could not start in <#${d.channel}>: ${e instanceof Error ? e.message : String(e)}`);
    await finishSkillCheck({ runId: run.runId, agentId: run.agentId, usage: {}, outcome: "error", pass: "heartbeat-wake" }).catch(() => {});
    return "failed";
  }
}

/** One wake across this agent's proactive channels, if one is due. Never throws for a transport failure. */
export async function runChannelWakes(r: Run, deps: WakeDeps): Promise<WakeResult> {
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
  await migrateChecklist(r, channels, deps);

  const due: (Job & { at: number; reason: string })[] = [];
  for (const channel of channels) {
    const mandate = m.channels[channel] ?? m.global;
    const { page, hash } = await channelJob(r, channel, mandate, deps);
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
    if (gate.due) due.push({ channel, mandate, page, hash: hash!, at: state?.nextCheckAt ?? 0, reason: gate.reason, state });
  }
  if (due.length === 0) return "idle";
  due.sort((a, b) => a.at - b.at || a.channel.localeCompare(b.channel));

  // One at a time across the agent. The stale sweep ends a run that lost its finish.
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

  for (const d of due) {
    const out = await startChannelWake(r, d, managerId, app, d.reason, deps, notice);
    if (out !== "busy") return out;
    // This channel stays due; the next one may go.
  }
  return "busy";
}

/**
 * `/heartbeat now` at a proactive channel's root: this channel's wake, now, past
 * the gate. Busy (another wake, or a person's turn) marks nothing and starts
 * nothing. The caller has checked who asked.
 */
export async function runChannelWakeNow(r: Run, channel: string, deps: WakeDeps): Promise<WakeResult | "not-proactive"> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat-wake`;
  const count = (result: string) => metric.wakeGateTotal.inc({ agent: r.agentId, result });
  const channels = (deps.channelsOn ?? channelSessionWakes)(r.personaId);
  if (!channels.includes(channel)) return "not-proactive";
  const managerId = deps.managerId(r.personaId);
  const app = await deps.app(r.personaId).catch(() => undefined);
  if (!app?.teamId || !managerId) {
    console.warn(`${tag}: no Slack team or manager is known; cannot wake`);
    return "no-team";
  }
  const open = await Runs.listOpen("heartbeat-wake", r.now.getTime() + 1);
  if (open.some((o) => o.agentId === r.agentId)) {
    count("busy");
    console.log(`${tag}: a wake is still running; not starting another`);
    return "busy";
  }
  await migrateChecklist(r, channels, deps);
  const m = deps.mandates(r.personaId, [channel]);
  const mandate = m.channels[channel] ?? m.global;
  const { page, hash } = await channelJob(r, channel, mandate, deps);
  if (hash === null) return "no-checklist";
  const state = await ChannelWake.get(r.agentId, channel);
  const notice = { managerId, app, post: deps.post, at: r.now, tag };
  return startChannelWake(r, { channel, mandate, page, hash, state }, managerId, app, "now", deps, notice);
}
