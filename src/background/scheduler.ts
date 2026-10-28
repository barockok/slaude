/**
 * The background scheduler (spec §9.1; rulings A, B): one loop that, every
 * TICK_MS, sweeps stale runs of every pass, works out which schedule slots are
 * due for each agent, claims each slot in `background_slots`, and runs it;
 * then scans the agent's threads for quiet moments (below).
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
 * Every tick also expires the open proposals past their 14 days (DB only, so
 * it runs with the brain closed, like the stale-run sweep).
 *
 * The quiet-moment pass is not on the clock: after an agent's scheduled slots,
 * each tick claims and runs its due quiet threads (passes/quiet-moment.ts),
 * each under the slot `<session>@<last_turn_at>`.
 *
 * Runs only where the brain lives: the gateway role, elected through the
 * leader loop (one replica at a time), and mono, directly. Never on nodes,
 * never without the brain enabled, and never implicitly: createGateway starts
 * it only when asked (server.ts does; tests start it explicitly with injected
 * deps). A tick while the brain is not open is skipped; it never boots one.
 *
 * Leadership can move mid-pass (a missed renewal, a dead pod): a slot is
 * claimed with an INSERT before its pass starts, so a later leader never
 * re-runs it. A demoted leader starts no further slot, and the pass it is in
 * is cut short: the leader loop aborts the term's signal, so that pass ends
 * after its current turn as `error` (logged as shutting down); its slot stays
 * claimed and is not re-run.
 */
import type { Redis } from "ioredis";
import * as Runs from "../db/background-runs";
import * as Sessions from "../db/sessions";
import { claimSlot } from "../db/background-slots";
import * as Proposals from "../db/proposals";
import { registerLoop } from "../gateway/core/running-loops";
import { brainAdminCall, brainCall, brainCallIfOpen, brainReady } from "../knowledge/brain";
import { m as metric } from "../metrics";
import { getPersonaRegistry, managedPersonaProvider, personaDefaultModel } from "../persona/registry";
import { personaKbList } from "../knowledge/persona-kb";
import { leaderLoop } from "../queue/locks";
import { redactSecrets } from "../gateway/core/status-text";
import { localDay, type PassName } from "./budget";
import { isoWeekSlot, localParts, previousDay } from "./calendar";
import { budgetConfigFor } from "./config";
import { runDigest } from "./digest";
import { postPersonProposals, type CardPost } from "./proposal-cards";
import { runLessonsUpkeep } from "./passes/lessons-upkeep";
import { runNightlyReview, type NightlyDeps } from "./passes/nightly-review";
import { dueQuietThreads, quietSlot, runQuietMoment } from "./passes/quiet-moment";
import { runSkillReview } from "./passes/skill-review";
import type { ThreadActivity } from "../db/thread-activity";
import { defaultRunnerDeps } from "./runner";
import { backgroundAgentId, finishSkillCheck, startSkillCheck } from "./skill-check";
import { runDueCommitments, type PromiseTransport } from "../proactive/promises";
import type { ProactiveTransport } from "../proactive/dispatch";
import { readPingPrefs } from "../proactive/prefs";
import { runHeartbeat } from "../proactive/heartbeat";
import { bridgeExternalMcp } from "../gateway/core/external-mcp";
import { anyProactiveEnabled } from "../soul/proactive";
import { env } from "../config/env";
import { personaApp } from "./digest";
import { soulData, cachedSoulData, channelMandate } from "../soul/extract";
import { personaSoulText } from "../persona/soul-source";
import { sweepStaleRuns } from "./stale-runs";
import type { SourceReader } from "../proactive/source-reader";

export { isoWeekSlot, previousDay };

export const TICK_MS = 60_000;
/** Longest stop() waits for a pass in flight to wind down after the abort (shutdown must not hang on a review). */
export const STOP_GRACE_MS = 10_000;

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
  /** Run only after this pass's rows for the slot's day have all finished. */
  after?: PassName;
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
  /** Default: sweepStaleRuns (every pass's runs that lost their finish). */
  sweep?: (now: Date) => Promise<unknown>;
  /** Default: Proposals.expireDue (open proposals past expires_at become expired). */
  expire?: (now: Date) => Promise<unknown>;
  /** The group's threads due a quiet-moment pass. Default: dueQuietThreads (env thresholds). */
  quietDue?: (g: AgentGroup, now: Date) => Promise<ThreadActivity[]>;
  /** Default: a timer that the signal cuts short. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Check the group's due promises (phase E, src/proactive/promises.ts).
   *  Runs first every tick: due promises are top priority. Absent: none. */
  commitments?: (g: AgentGroup, now: Date) => Promise<unknown>;
  /** Whether a persona's SOUL turns proactiveness on anywhere (the heartbeat
   *  runs only then). Default: anyProactiveEnabled. */
  proactiveOn?: (personaId: string) => boolean;
}

/** `after`: the pass runs only once that pass's ledger rows for the same day have all finished. */
type Entry = { pass: PassName; minutes: number; after?: PassName } & ({ every: "day" } | { every: "week"; weekday: number });

/** The schedule, in run order within a tick. */
const SCHEDULE: readonly Entry[] = [
  { pass: "nightly-review", every: "day", minutes: 2 * 60 + 30 },
  // After the nightly's rows settle: a new leader must not merge the proposals
  // page while the old leader's nightly agent pass is still rewriting it. A day
  // whose nightly ran no pass (no conversations) has no upkeep; its proposals
  // wait for the next. After a budget-skipped nightly the upkeep still runs: it
  // merges earlier days' proposals, and its own budget check decides.
  { pass: "lessons-upkeep", every: "day", minutes: 2 * 60 + 30, after: "nightly-review" },
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
    if (last[e.pass] !== slot) out.push({ pass: e.pass, slot, ...(e.after ? { after: e.after } : {}) });
  }
  return out;
}

/** The heartbeat slot of `now`: persona-local `YYYY-MM-DDTHH:MM`, rounded down to the interval. */
export function heartbeatSlot(now: Date, tz: string, everyMinutes: number): string {
  const t = localParts(now, tz);
  const m = Math.floor(t.minutes / everyMinutes) * everyMinutes;
  return `${t.day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
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
  const sweep = deps.sweep ?? ((now: Date) => sweepStaleRuns(now));
  const expire = deps.expire ?? ((now: Date) => Proposals.expireDue(now.getTime()));
  const quietDue = deps.quietDue ?? ((g: AgentGroup, now: Date) => dueQuietThreads(g, now));

  /** Claim a slot and run its handler; a throw is recorded as an error run. */
  const runSlot = async (g: AgentGroup, pass: PassName, slot: string, now: Date, signal: AbortSignal, handler: SlotHandler, claim: () => Promise<boolean>): Promise<boolean> => {
    const tag = `[background] agent=${g.agentId} pass=${pass} slot=${slot}`;
    let mine: boolean;
    try {
      mine = await claim();
    } catch (e) {
      console.error(`${tag}: could not claim: ${errText(e)}`);
      return false;
    }
    if (!mine) return true;
    try {
      await handler({ ...g, pass, slot, now, signal });
    } catch (e) {
      console.error(`${tag}: failed: ${errText(e)}`);
      await recordError(g.agentId, pass, localDay(now, g.timeZone), now).catch((e2) =>
        console.error(`${tag}: could not record the failure: ${errText(e2)}`),
      );
    }
    return true;
  };

  return {
    async tick(signal = new AbortController().signal) {
      const now = deps.now();
      try {
        await sweep(now);
      } catch (e) {
        console.error(`[background] stale-run sweep failed: ${errText(e)}`);
      }
      try {
        const n = await expire(now);
        if (typeof n === "number" && n > 0) console.log(`[background] ${n} unanswered proposal(s) expired`);
      } catch (e) {
        console.error(`[background] proposal expiry failed: ${errText(e)}`);
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
      // Due promises first, for every agent, before any pass: they are top priority.
      if (deps.commitments) {
        for (const g of groups) {
          if (signal.aborted) return;
          try {
            await deps.commitments(g, now);
          } catch (e) {
            console.error(`[background] agent=${g.agentId} pass=commitment: ${errText(e)}`);
          }
        }
      }
      for (const g of groups) {
        const seen = last.get(g.agentId) ?? {};
        last.set(g.agentId, seen);
        for (const { pass, slot, after } of dueSlots(now, g.timeZone, seen)) {
          if (signal.aborted) return;
          const handler = deps.handlers[pass];
          if (!handler) continue;
          const tag = `[background] agent=${g.agentId} pass=${pass} slot=${slot}`;
          try {
            // Not claimed until it may run, so a later tick (or replica) still can.
            if (after && !(await Runs.settledOn(g.agentId, after, localDay(now, g.timeZone)))) {
              console.debug(`${tag}: waiting for ${after} to finish`);
              continue;
            }
          } catch (e) {
            console.error(`${tag}: could not claim: ${errText(e)}`);
            continue;
          }
          if (await runSlot(g, pass, slot, now, signal, handler, () => claimSlot(g.agentId, pass, slot, now.getTime()))) seen[pass] = slot;
        }
        // The heartbeat (phase E): every SLAUDE_HEARTBEAT_MINUTES, only while
        // the persona's SOUL enables proactiveness somewhere.
        const heartbeat = deps.handlers.heartbeat;
        if (heartbeat && !signal.aborted && (deps.proactiveOn ?? anyProactiveEnabled)(g.personaId)) {
          const slot = heartbeatSlot(now, g.timeZone, env.heartbeatMinutes());
          if (seen.heartbeat !== slot && (await runSlot(g, "heartbeat", slot, now, signal, heartbeat, () => claimSlot(g.agentId, "heartbeat", slot, now.getTime())))) {
            seen.heartbeat = slot;
          }
        }
        const quiet = deps.handlers["quiet-moment"];
        if (!quiet || signal.aborted) continue;
        let due: ThreadActivity[];
        try {
          due = await quietDue(g, now);
        } catch (e) {
          console.error(`[background] agent=${g.agentId} pass=quiet-moment: could not list quiet threads: ${errText(e)}`);
          continue;
        }
        for (const t of due) {
          if (signal.aborted) return;
          const slot = quietSlot(t.sessionId, t.lastTurnAt);
          await runSlot(g, "quiet-moment", slot, now, signal, quiet, () => claimSlot(g.agentId, "quiet-moment", slot, now.getTime()));
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
 * replica leads; without it (mono) it ticks from now on. stop() aborts it (the
 * pass in flight ends after its current turn) and waits at most `graceMs`
 * (default STOP_GRACE_MS) for it to finish; past that it returns and the loop
 * winds down on its own.
 */
export function startBackgroundScheduler(deps: SchedulerDeps, opts: { elect?: Elect } = {}): { stop(graceMs?: number): Promise<void> } {
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
  let stopping: Promise<void> | null = null;
  const stop = async (graceMs = STOP_GRACE_MS) => {
    if (!stopped) {
      stopped = true;
      unregister();
      stopping = stopFn().catch((e) => console.error(`[background] scheduler stop failed: ${errText(e)}`));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), graceMs);
      timer.unref?.();
    });
    const r = await Promise.race([stopping!.then(() => "done" as const), grace]);
    clearTimeout(timer);
    if (r === "late") console.warn(`[background] scheduler still finishing a pass after ${graceMs} ms; not waiting for it`);
  };
  unregister = registerLoop(() => void stop());
  return { stop };
}

/** The provider_creds rows a persona's passes use, as a fingerprint (gateway code, loaded lazily). */
async function defaultProviderRows(personaId: string): Promise<string | null> {
  const { providerRowsFingerprint } = await import("../gateway/api/tenants");
  return providerRowsFingerprint(personaId);
}

/**
 * What a pass routes on for a persona: its declared provider, the
 * provider_creds rows it would use (a fingerprint, never the values), its
 * model and its KB filter.
 */
async function routingKey(personaId: string, providerRows: (p: string) => Promise<string | null>): Promise<string> {
  const named = personaId === "default" ? undefined : personaId;
  const kbs = personaKbList(named);
  return JSON.stringify([managedPersonaProvider(named) ?? null, await providerRows(personaId), personaDefaultModel(named), kbs ? [...kbs].sort() : null]);
}

/** Personas already logged as left out of a group (one line each per process). */
const loggedUngrouped = new Set<string>();

/**
 * The agent groups to schedule: the default persona and every named persona,
 * grouped by the agent id their ledger and brain slice use (backgroundAgentId).
 * A persona that cannot be resolved (retired mid-sync) is left out this tick.
 *
 * A group's passes run with its first persona's provider, model and KB filter,
 * so a persona whose declared provider, provider_creds rows, model or
 * kbSources differ from the group's is never merged into it: its people's
 * transcripts would go to another persona's provider host, and the pass
 * could read KBs its filter excludes. It is left out (one log line) and has no background passes until
 * it has its own Slack user id (its own agent id and group).
 */
export async function defaultAgentGroups(providerRows: (personaId: string) => Promise<string | null> = defaultProviderRows): Promise<AgentGroup[]> {
  let names: string[] = [];
  try {
    names = getPersonaRegistry().list().map((p) => p.name).filter((n) => n && n !== "default");
  } catch (e) {
    console.error(`[background] could not read the persona registry; scheduling the default persona only: ${errText(e)}`);
    names = [];
  }
  const groups = new Map<string, AgentGroup & { key: string | null }>();
  for (const personaId of ["default", ...names.sort()]) {
    let agentId: string;
    try {
      agentId = await backgroundAgentId(personaId);
    } catch (e) {
      console.warn(`[background] persona=${personaId}: not scheduled: ${errText(e)}`);
      continue;
    }
    // Unknown (the registry could not say): may lead a group, never joins one.
    let key: string | null = null;
    try {
      key = await routingKey(personaId, providerRows);
    } catch {
      /* left null */
    }
    const g = groups.get(agentId);
    if (!g) {
      groups.set(agentId, { agentId, personaId, personaIds: [personaId], timeZone: budgetConfigFor(personaId).timeZone, key });
    } else if (key !== null && g.key === key) {
      g.personaIds.push(personaId);
    } else if (!loggedUngrouped.has(`${agentId}/${personaId}`)) {
      loggedUngrouped.add(`${agentId}/${personaId}`);
      console.error(
        `[background] persona=${personaId}: no background passes: it shares agent id ${agentId} with persona=${g.personaId} but its provider, model or kbSources differ; give it its own slackUserId`,
      );
    }
  }
  return [...groups.values()].map(({ key: _key, ...g }) => g);
}

/** Brain source ids, through the trusted admin path. */
async function listBrainSources(): Promise<string[]> {
  const listed = (await brainAdminCall("sources_list", {})) as { sources?: Array<{ id: string }> } | null;
  return (listed?.sources ?? []).map((s) => s.id);
}

/** Where the scheduler's messages go: the gateway's Slack (absent in tests and without Slack). */
export interface SchedulerSlack {
  /** Posts as the agent's bot; `channel` is a user id for a DM. */
  post: CardPost;
  /** How promise checks reach their threads (phase E). Absent: promises are not checked. */
  promises?: PromiseTransport;
  /** How the heartbeat round's ask/act turns reach their post's thread. Absent: such items are only posted. */
  proactive?: ProactiveTransport;
  /** The agent's own MCP sources, read as the agent (heartbeat round). Absent: no source is read. */
  sources?: SourceReader;
  /** Mono: the agent's OAuth credentials live in the CLI's own store, which the heartbeat cannot read (HeartbeatDeps.agentOAuthInCli). */
  agentOAuthInCli?: boolean;
  /** The manager and the backup manager (who may decide manager proposals). */
  managers: () => string[];
  /** Whom the weekly digest goes to: the manager, else the backup manager. */
  digestRecipient: () => string | null;
}

/** Production handlers: the nightly review, the lessons upkeep, the quiet-moment pass, the weekly skill review and the weekly digest. */
export function passHandlers(deps: NightlyDeps, slack?: SchedulerSlack): Partial<Record<PassName, SlotHandler>> {
  return {
    "nightly-review": (r) => runNightlyReview(r, deps),
    "lessons-upkeep": (r) => runLessonsUpkeep(r, deps),
    "quiet-moment": (r) => runQuietMoment(r, deps),
    "skill-review": (r) => runSkillReview(r, deps),
    digest: (r) => runDigest(r, { call: deps.call, recipient: slack?.digestRecipient ?? (() => null), ...(slack ? { post: slack.post } : {}) }),
    // The heartbeat needs Slack to speak: without it there is nothing to run.
    ...(slack
      ? {
          heartbeat: (r: SlotRun) =>
            runHeartbeat(r, {
              runner: deps.runner,
              call: deps.call,
              post: slack.post,
              managerId: personaManager,
              mandates: personaMandates,
              app: personaApp,
              // Read at run time: the gateway sets both after building the scheduler deps.
              ...(slack.sources ? { sources: slack.sources } : {}),
              ...(slack.proactive ? { proactive: slack.proactive } : {}),
              ...(slack.agentOAuthInCli ? { agentOAuthInCli: true } : {}),
              mcp: bridgeExternalMcp,
            }),
        }
      : {}),
  };
}

/** A persona's manager: the default persona's effective soul, a named persona's own structured soul. */
export function personaManager(personaId: string): string | null {
  try {
    if (!personaId || personaId === "default") return soulData().manager.userId ?? null;
    return cachedSoulData(personaSoulText(personaId))?.manager.userId ?? null;
  } catch {
    return null;
  }
}

export interface PersonaMandates {
  global: string;
  channels: Record<string, string | null>;
}

/** A persona's global mandate and each listed channel's own (null: it follows the global one). Never throws. */
export function personaMandates(personaId: string, channelIds: readonly string[]): PersonaMandates {
  try {
    const soul = !personaId || personaId === "default" ? soulData() : cachedSoulData(personaSoulText(personaId));
    if (!soul) return { global: "", channels: {} };
    const channels: Record<string, string | null> = {};
    for (const c of channelIds) channels[c] = channelMandate(soul, c);
    return { global: soul.mandate ?? "", channels };
  } catch {
    return { global: "", channels: {} };
  }
}

/** Production promise checks for a group: budgeted on the ledger, prefs from the beneficiary's profile. */
export function promiseChecks(transport: PromiseTransport): (g: AgentGroup, now: Date) => Promise<number> {
  return (g, now) =>
    runDueCommitments(g.agentId, now, {
      transport,
      timeZone: g.timeZone,
      // A read that never boots the brain: the scheduler only runs with it open.
      prefs: async (row) => readPingPrefs(brainCallIfOpen, row.teamId ?? (await Sessions.teamForThread(row.channelId, row.threadTs)), row.beneficiary),
      openRun: async (row) => {
        const named = row.personaId && row.personaId !== "default" ? row.personaId : undefined;
        const r = await startSkillCheck({
          personaId: row.personaId || "default",
          model: personaDefaultModel(named),
          scope: row.runAs ? `user:${row.runAs}` : "agent",
          pass: "commitment",
        });
        return r.ok ? { ok: true, runId: r.runId, agentId: r.agentId } : { ok: false };
      },
      dropRun: async (runId, agentId) => {
        await finishSkillCheck({ runId, agentId, usage: {}, outcome: "error", pass: "commitment" });
      },
    });
}

/** The scheduler as the gateway and mono run it. */
export function defaultSchedulerDeps(slack?: SchedulerSlack): SchedulerDeps {
  return {
    ...(slack?.promises ? { commitments: promiseChecks(slack.promises) } : {}),
    now: () => new Date(),
    brainReady,
    agents: defaultAgentGroups,
    handlers: passHandlers(
      {
        runner: defaultRunnerDeps(),
        call: brainCall,
        listSources: listBrainSources,
        ...(slack ? { deliver: (a) => postPersonProposals({ ...a, post: slack.post }).then(() => {}) } : {}),
      },
      slack,
    ),
  };
}
