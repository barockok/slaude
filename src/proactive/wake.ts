/**
 * One heartbeat wake (heartbeat wake spec, section 2): the gate, the budget, then
 * a fresh session turn of the agent itself through the cron path. The agent does
 * its checklist's work with its own soul, tools and folder. Code decides whether
 * a wake starts, how much it may spend, and what may reach people.
 */
import { createHash } from "node:crypto";
import { spendLeft } from "../background/budget";
import { budgetConfigFor } from "../background/config";
import { renderPassPrompt } from "../background/prompts";
import type { CardPost } from "../background/proposal-cards";
import type { AgentGroup, PersonaMandates } from "../background/scheduler";
import { finishSkillCheck, startSkillCheck } from "../background/skill-check";
import { env } from "../config/env";
import * as Runs from "../db/background-runs";
import * as Posts from "../db/proactive-posts";
import * as WakeState from "../db/heartbeat-wake-state";
import type { AppRef } from "../gateway/core/transport";
import type { BrainOpCall } from "../knowledge/memory-trail";
import { m as metric } from "../metrics";
import { personaDefaultModel } from "../persona/registry";
import { proactiveChannels, proactiveFor, proactiveRead } from "../soul/proactive";
import { agentPageBody, heartbeatChecklist, line, OUT_OF_BUDGET_TEXT, recentPostLines, tellManagerOnce } from "./heartbeat";
import { loadRules } from "./rules";
import { wakeDue, type WakeGateConfig } from "./wake-gate";
import { WAKE_JOURNAL_SLUG } from "./wake-tools";
import { recentActivity, type ActivityReader } from "./wake-activity";

/** How long and how much one wake may run. Absent or 0: that cap is off. The pool always applies to the USD one. */
export interface WakeRunOptions {
  maxBudgetUsd?: number;
  maxTurns?: number;
  maxMinutes?: number;
}

/** A wake refused because a turn started on its channel session since `busy` was asked. Not a failure: nothing ran. */
export class WakeTargetBusyError extends Error {
  override readonly name = "WakeTargetBusyError";
}

/** Where a wake's turn goes. `channelId` is set for a channel session's wake. */
export interface WakeTarget {
  teamId: string;
  managerId: string;
  channelId?: string;
  threadTs: string;
  personaId: string;
  agentId: string;
  appId: string | undefined;
}

/** How a wake's turn reaches its session (the gateway implements it). */
export interface WakeTransport {
  dispatch(
    target: WakeTarget,
    envelope: string,
    run: { runId: string; agentId: string },
    caps: WakeRunOptions,
  ): Promise<void>;
  /** Whether a turn runs on this channel session now: its wake waits. Absent: never. */
  busy?(target: WakeTarget): Promise<boolean>;
}

export interface WakeDeps {
  call: BrainOpCall;
  post: CardPost;
  transport: WakeTransport;
  managerId: (personaId: string) => string | null;
  mandates: (personaId: string, channelIds: readonly string[]) => PersonaMandates;
  app: (personaId: string) => Promise<AppRef | undefined>;
  /** Reads Slack as this agent, for what happened since its last wake. Absent: no activity block. */
  activity?: (personaId: string, app: AppRef) => ActivityReader;
  /** Seams (tests). */
  gate?: () => WakeGateConfig;
  channelsOn?: (personaId: string) => string[];
  startRun?: typeof startSkillCheck;
  caps?: () => { maxUsd: number; maxTurns: number; maxMinutes: number };
  left?: (personaId: string, agentId: string, now: Date) => Promise<number>;
}

export type WakeResult = "woke" | "idle" | "no-checklist" | "busy" | "no-budget" | "no-model" | "no-team" | "failed";

/** The gate's settings from the environment. */
export function wakeGateConfig(): WakeGateConfig {
  return { slotMs: env.heartbeatMinutes() * 60_000, maxSleepMs: env.wakeMaxSleepHours() * 3_600_000 };
}

export const checklistHash = (checklist: string): string => createHash("sha256").update(checklist).digest("hex");

export const FAILURES_WORTH_A_NOTICE = 3;

/** One wake's caps. The daily pool cannot be disabled: a run never spends past what is left. */
export function wakeCaps(deps: Pick<WakeDeps, "caps">, left: number): WakeRunOptions {
  const caps = (deps.caps ?? (() => ({ maxUsd: env.wakeMaxUsd(), maxTurns: env.wakeMaxTurns(), maxMinutes: env.wakeMaxMinutes() })))();
  return {
    maxBudgetUsd: caps.maxUsd > 0 ? Math.min(caps.maxUsd, left) : left,
    ...(caps.maxTurns > 0 ? { maxTurns: caps.maxTurns } : {}),
    ...(caps.maxMinutes > 0 ? { maxMinutes: caps.maxMinutes } : {}),
  };
}

async function activityBlock(r: AgentGroup & { now: Date }, channels: readonly string[], lastWakeAt: number | null, app: AppRef, deps: WakeDeps): Promise<string> {
  if (!deps.activity) return "(not available)";
  try {
    const posts = await Posts.recentByAgent(r.agentId, r.now.getTime() - 7 * 86_400_000, 30);
    return await recentActivity({ reader: deps.activity(r.personaId, app), channels: [...new Set([...channels, ...proactiveRead(r.personaId)])], posts, agentId: r.agentId, lastWakeAt, now: r.now });
  } catch (e) {
    console.warn(`[background] agent=${r.agentId} pass=heartbeat-wake: could not read activity: ${e instanceof Error ? e.message : String(e)}`);
    return "(could not be read this time; say so rather than assume nothing happened)";
  }
}

/** One wake, if one is due. Never throws for a transport failure: the run ends as an error, and the backoff applies. */
export async function runWake(r: AgentGroup & { slot: string; now: Date; signal?: AbortSignal }, deps: WakeDeps): Promise<WakeResult> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat-wake`;
  if (r.signal?.aborted) return "idle";
  const count = (result: string) => metric.wakeGateTotal.inc({ agent: r.agentId, result });
  const now = r.now.getTime();
  const managerId = deps.managerId(r.personaId);
  const app = await deps.app(r.personaId).catch(() => undefined);
  const notice = { managerId, app, post: deps.post, at: r.now, tag };

  // The agent's job is its mandates plus its optional checklist: turning
  // proactiveness on in a place with a mandate is enough for it to start.
  const checklist = await heartbeatChecklist(r.agentId, deps.call);
  const channels = (deps.channelsOn ?? proactiveChannels)(r.personaId);
  const m = deps.mandates(r.personaId, channels);
  const placed = channels.map((c) => m.channels[c] ?? m.global);
  const job = [checklist, ...(proactiveFor(r.personaId).enabled ? [m.global] : []), ...placed].filter(Boolean).join("\n");
  const hash = job ? checklistHash(job) : null;
  const state = await WakeState.get(r.agentId);
  if (state && state.failures >= FAILURES_WORTH_A_NOTICE) {
    await tellManagerOnce(r, "wake-failures", `My last ${state.failures} recurring checks failed (last result: ${line(state.lastOutcome) || "unknown"}). Please take a look.`, notice);
  }
  const gate = wakeDue(state, hash, now, (deps.gate ?? wakeGateConfig)());
  count(gate.reason);
  if (!gate.due) return gate.reason === "no-checklist" ? "no-checklist" : "idle";

  // One at a time. The stale sweep ends a run that lost its finish.
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
  const left = await (deps.left ?? ((p, a, at) => spendLeft(budgetConfigFor(p), a, "heartbeat-wake", at)))(r.personaId, r.agentId, r.now);
  const run = await (deps.startRun ?? startSkillCheck)({ personaId: r.personaId, model: personaDefaultModel(named), scope: "agent", pass: "heartbeat-wake" });
  if (!run.ok) {
    if (run.reason === "budget") {
      count("no-budget");
      await tellManagerOnce(r, "budget", OUT_OF_BUDGET_TEXT, notice);
      return "no-budget";
    }
    return "no-model";
  }

  try {
    await WakeState.noteStart(r.agentId, hash!, now);
    const strip = (s: string, t: string) => s.replace(new RegExp(`</?${t}>`, "gi"), "");
    const rules = await loadRules(r.agentId, deps.call);
    const destinations = [
      ...(proactiveFor(r.personaId).enabled ? [`- Your manager, or a person who asked: ${line(m.global, Number.MAX_SAFE_INTEGER) || "your mandate"}`] : []),
      ...channels.map((c) => `- <#${c}>: ${line(m.channels[c] ?? m.global, Number.MAX_SAFE_INTEGER) || "your mandate"}`),
    ];
    const envelope = renderPassPrompt("heartbeat-wake", {
      NOW: new Date(now).toISOString(),
      TIME_ZONE: r.timeZone,
      CHECKLIST: strip(checklist, "checklist") || "(none: your mandate above is your job)",
      ACTIVITY: strip(await activityBlock(r, channels, state?.lastWakeAt ?? null, app, deps), "activity"),
      JOURNAL: strip(await agentPageBody(r.agentId, deps.call, WAKE_JOURNAL_SLUG), "notes") || "(none yet)",
      RULES: rules.map((x) => `- ${line(x.slug)} · ${line(x.kind)} · ${line(x.scope)} · ${x.level}`).join("\n") || "(none)",
      RECENT_POSTS: await recentPostLines(r.agentId, deps.call, r.now),
      DESTINATIONS: destinations.join("\n") || "(none)",
      MANAGER: managerId,
    });
    await deps.transport.dispatch(
      { teamId: app.teamId, managerId, threadTs: `wake:${r.agentId}:${r.slot}`, personaId: r.personaId, agentId: r.agentId, appId: app.apiAppId },
      envelope,
      { runId: run.runId, agentId: run.agentId },
      wakeCaps(deps, left),
    );
    console.log(`${tag}: woke (${gate.reason})`);
    return "woke";
  } catch (e) {
    console.error(`${tag}: could not start: ${e instanceof Error ? e.message : String(e)}`);
    await finishSkillCheck({ runId: run.runId, agentId: run.agentId, usage: {}, outcome: "error", pass: "heartbeat-wake" }).catch(() => {});
    return "failed";
  }
}
