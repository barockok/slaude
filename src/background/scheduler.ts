/**
 * The background scheduler (spec §9.1; rulings A, B): one loop that, every
 * TICK_MS, sweeps stale skill-check runs, works out which schedule slots are
 * due for each agent, claims each slot in `background_slots`, and runs it.
 *
 * Schedule (persona-local time, global constraints):
 *   nightly-review   daily 02:30, then lessons-upkeep (same slot, right after);
 *   skill-review     Sunday 04:00;
 *   digest           Monday 09:00.
 * A slot is the period it belongs to: `YYYY-MM-DD` for a daily pass, the ISO
 * week `YYYY-Www` for a weekly one. It is due from its scheduled time until the
 * period ends, so a scheduler that was down at 02:30 runs it late rather than
 * never; an earlier period's missed slot is never run.
 *
 * Runs only where the brain lives: the gateway role, elected through the
 * leader loop (one replica at a time), and mono, directly. Never on nodes,
 * never without the brain enabled, and never implicitly: createGateway starts
 * it only when asked (server.ts does; tests start it explicitly with injected
 * deps). A tick while the brain is not open is skipped; it never boots one.
 *
 * Leadership can move mid-pass (a missed renewal, a dead pod): a slot is
 * claimed with an INSERT before its pass starts, so a later leader never
 * re-runs it. A demoted leader starts no further slot but finishes the pass it
 * is in (a pass is bounded by its max-turns cap and the budget).
 */
import type { Redis } from "ioredis";
import * as Runs from "../db/background-runs";
import { claimSlot } from "../db/background-slots";
import { registerLoop } from "../gateway/core/running-loops";
import { brainAdminCall, brainCall, brainReady } from "../knowledge/brain";
import { m as metric } from "../metrics";
import { getPersonaRegistry } from "../persona/registry";
import { leaderLoop } from "../queue/locks";
import { redactSecrets } from "../gateway/core/status-text";
import { localDay, type PassName } from "./budget";
import { isoWeekSlot, localParts, previousDay } from "./calendar";
import { budgetConfigFor } from "./config";
import { runLessonsUpkeep } from "./passes/lessons-upkeep";
import { runNightlyReview, type NightlyDeps } from "./passes/nightly-review";
import { defaultRunnerDeps } from "./runner";
import { backgroundAgentId, sweepStaleSkillChecks } from "./skill-check";

export { isoWeekSlot, previousDay };

export const TICK_MS = 60_000;

/** Personas whose background passes share one agent id (one ledger, one `agent-<id>` slice). */
export interface AgentGroup {
  agentId: string;
  /** The persona whose model, provider, budget and timezone the passes use. */
  personaId: string;
  /** Every persona with this agent id: their sessions are this agent's conversations. */
  personaIds: string[];
  timeZone: string;
}

export interface DueSlot {
  pass: PassName;
  slot: string;
}

/** Per pass, the slot this scheduler last claimed or found claimed. */
export type LastSlots = Partial<Record<PassName, string>>;

export interface SlotRun extends AgentGroup {
  pass: PassName;
  slot: string;
  now: Date;
  signal: AbortSignal;
}

export type SlotHandler = (r: SlotRun) => Promise<unknown>;

export interface SchedulerDeps {
  now: () => Date;
  brainReady: () => boolean;
  agents: () => Promise<AgentGroup[]>;
  /** A pass with no handler is never claimed, so a handler added later still gets its slot. */
  handlers: Partial<Record<PassName, SlotHandler>>;
  /** Default: sweepStaleSkillChecks. */
  sweep?: (now: Date) => Promise<unknown>;
  /** Default: a timer that the signal cuts short. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Entry = { pass: PassName; minutes: number } & ({ every: "day" } | { every: "week"; weekday: number });

/** The schedule, in run order within a tick. */
const SCHEDULE: readonly Entry[] = [
  { pass: "nightly-review", every: "day", minutes: 2 * 60 + 30 },
  { pass: "lessons-upkeep", every: "day", minutes: 2 * 60 + 30 },
  { pass: "skill-review", every: "week", weekday: 7, minutes: 4 * 60 },
  { pass: "digest", every: "week", weekday: 1, minutes: 9 * 60 },
];

/**
 * The slots due at `now` in `tz` that are not `last`'s: each pass's current
 * period, once its scheduled time in that period has passed.
 */
export function dueSlots(now: Date, tz: string, last: LastSlots = {}): DueSlot[] {
  const t = localParts(now, tz);
  const out: DueSlot[] = [];
  for (const e of SCHEDULE) {
    const reached = e.every === "day" ? t.minutes >= e.minutes : t.weekday > e.weekday || (t.weekday === e.weekday && t.minutes >= e.minutes);
    if (!reached) continue;
    const slot = e.every === "day" ? t.day : isoWeekSlot(t.day);
    if (last[e.pass] !== slot) out.push({ pass: e.pass, slot });
  }
  return out;
}

const errText = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

/** A slot whose handler threw: one `error` ledger row, as a failed pass records. */
async function recordError(agentId: string, pass: PassName, day: string, at: Date): Promise<void> {
  const id = await Runs.start({ agentId, pass, scope: "agent", day, startedAt: at.getTime(), model: null });
  await Runs.finish(id, { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, costUsd: 0, outcome: "error" });
  metric.backgroundRunsTotal.inc({ agent: agentId, pass, outcome: "error" });
}

export function createBackgroundScheduler(deps: SchedulerDeps): { tick(signal?: AbortSignal): Promise<void> } {
  const last = new Map<string, LastSlots>();
  const sweep = deps.sweep ?? ((now: Date) => sweepStaleSkillChecks(now));

  return {
    async tick(signal = new AbortController().signal) {
      const now = deps.now();
      try {
        await sweep(now);
      } catch (e) {
        console.error(`[background] stale skill-check sweep failed: ${errText(e)}`);
      }
      if (!deps.brainReady()) {
        console.debug("[background] brain not open; scheduler tick skipped");
        return;
      }
      let groups: AgentGroup[];
      try {
        groups = await deps.agents();
      } catch (e) {
        console.error(`[background] could not list agents: ${errText(e)}`);
        return;
      }
      for (const g of groups) {
        const seen = last.get(g.agentId) ?? {};
        last.set(g.agentId, seen);
        for (const { pass, slot } of dueSlots(now, g.timeZone, seen)) {
          if (signal.aborted) return;
          const handler = deps.handlers[pass];
          if (!handler) continue;
          const tag = `[background] agent=${g.agentId} pass=${pass} slot=${slot}`;
          let mine: boolean;
          try {
            mine = await claimSlot(g.agentId, pass, slot, now.getTime());
          } catch (e) {
            console.error(`${tag}: could not claim: ${errText(e)}`);
            continue;
          }
          seen[pass] = slot;
          if (!mine) continue;
          try {
            await handler({ ...g, pass, slot, now, signal });
          } catch (e) {
            console.error(`${tag}: failed: ${errText(e)}`);
            await recordError(g.agentId, pass, localDay(now, g.timeZone), now).catch((e2) =>
              console.error(`${tag}: could not record the failure: ${errText(e2)}`),
            );
          }
        }
      }
    },
  };
}

const timerSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** Run leadership terms: the gateway's leader loop (or a fake in tests). */
export type Elect = (fn: (signal: AbortSignal) => Promise<void>) => { stop(): Promise<void> };

/** The gateway's election: the `background` leader role over Redis. */
export function leaderElect(redis: Redis): Elect {
  return (fn) => leaderLoop("background", fn, { redis, onError: (e) => console.error(`[background] leader loop: ${errText(e)}`) });
}

/**
 * Start the scheduler loop: under `elect` (gateway) it ticks only while this
 * replica leads; without it (mono) it ticks from now on. stop() ends it.
 */
export function startBackgroundScheduler(deps: SchedulerDeps, opts: { elect?: Elect } = {}): { stop(): Promise<void> } {
  const scheduler = createBackgroundScheduler(deps);
  const sleep = deps.sleep ?? timerSleep;
  const loop = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        await scheduler.tick(signal);
      } catch (e) {
        console.error(`[background] scheduler tick failed: ${errText(e)}`);
      }
      await sleep(TICK_MS, signal);
    }
  };
  let stopped = false;
  let stopFn: () => Promise<void>;
  if (opts.elect) {
    const h = opts.elect(loop);
    stopFn = () => h.stop();
  } else {
    const ac = new AbortController();
    const running = loop(ac.signal);
    stopFn = async () => {
      ac.abort();
      await running;
    };
  }
  let unregister = () => {};
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    unregister();
    await stopFn();
  };
  unregister = registerLoop(() => void stop());
  return { stop };
}

/**
 * The agent groups to schedule: the default persona and every named persona,
 * grouped by the agent id their ledger and brain slice use (backgroundAgentId).
 * A persona that cannot be resolved (retired mid-sync) is left out this tick.
 */
export async function defaultAgentGroups(): Promise<AgentGroup[]> {
  let names: string[] = [];
  try {
    names = getPersonaRegistry().list().map((p) => p.name).filter((n) => n && n !== "default");
  } catch {
    names = [];
  }
  const groups = new Map<string, AgentGroup>();
  for (const personaId of ["default", ...names.sort()]) {
    let agentId: string;
    try {
      agentId = await backgroundAgentId(personaId);
    } catch (e) {
      console.warn(`[background] persona=${personaId}: not scheduled: ${errText(e)}`);
      continue;
    }
    const g = groups.get(agentId);
    if (g) g.personaIds.push(personaId);
    else groups.set(agentId, { agentId, personaId, personaIds: [personaId], timeZone: budgetConfigFor(personaId).timeZone });
  }
  return [...groups.values()];
}

/** Brain source ids, through the trusted admin path. */
async function listBrainSources(): Promise<string[]> {
  const listed = (await brainAdminCall("sources_list", {})) as { sources?: Array<{ id: string }> } | null;
  return (listed?.sources ?? []).map((s) => s.id);
}

/** Production handlers: the nightly review and the lessons upkeep. */
export function passHandlers(deps: NightlyDeps): Partial<Record<PassName, SlotHandler>> {
  return {
    "nightly-review": (r) => runNightlyReview(r, deps),
    "lessons-upkeep": (r) => runLessonsUpkeep(r, deps),
  };
}

/** The scheduler as the gateway and mono run it. */
export function defaultSchedulerDeps(): SchedulerDeps {
  return {
    now: () => new Date(),
    brainReady,
    agents: defaultAgentGroups,
    handlers: passHandlers({ runner: defaultRunnerDeps(), call: brainCall, listSources: listBrainSources }),
  };
}
