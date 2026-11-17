/**
 * What a channel's wake is made of: its caps, its gate settings and how its turn
 * reaches the session. Code decides whether a wake starts, how much it may spend,
 * and what may reach people. The wake itself is in channel-wake.ts.
 */
import { createHash } from "node:crypto";
import type { CardPost } from "../background/proposal-cards";
import type { PersonaMandates } from "../background/scheduler";
import type { startSkillCheck } from "../background/skill-check";
import { env } from "../config/env";
import type { AppRef } from "../gateway/core/transport";
import type { BrainOpCall } from "../knowledge/memory-trail";
import type { WakeGateConfig } from "./wake-gate";

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

/** Where a wake's turn goes: one channel's session. */
export interface WakeTarget {
  teamId: string;
  managerId: string;
  channelId: string;
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
