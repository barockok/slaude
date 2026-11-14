/**
 * First sight (slice B, task 6): the first time a Slack user or channel shows
 * up in a session row, an audit event or an admission decision, an `observed`
 * record is created for it (source `first-sight`).
 *
 * Contract:
 *  - Fire and forget. `observeSlackUser` and `observeSlackChannel` return
 *    nothing and never throw; a failed write is logged once per key and never
 *    blocks a turn.
 *  - The hot path adds no query: a per-process LRU (5000 keys) remembers keys
 *    written (or found) in the last 10 minutes. A failed write is not cached.
 *  - Observed never overrides a stronger state (the repo only raises a state)
 *    and creates no user->account link.
 *  - Grid ids (W...), bot ids (B...), USLACKBOT and anything that is not a
 *    Slack id are skipped. A Slack record is never written with workspace ''.
 *  - A node has no database: nothing happens when SLAUDE_ROLE=node.
 *  - New records emit `user.created`, `binding.created`, `boundary.created`
 *    through `emitDomainEvents`. That audit write is made with actor kind
 *    `system` and inside an async-local guard, so the audit seam that calls
 *    this module never observes its own output. More than 50 new records in
 *    one minute: one summary event for the window, no more per-row events.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env";
import { db as globalDb, type DbClient } from "../db/schema";
import * as Domain from "../db/domain";
import type { DomainEvent } from "../db/domain";
import { trackFirstSight } from "./first-sight-flush";

export const LRU_CAP = 5000;
export const RECHECK_MS = 10 * 60 * 1000;
export const BURST_WINDOW_MS = 60 * 1000;
export const BURST_LIMIT = 50;
export const SUMMARY_ACTION = "domain.first_sight.burst";
const LOG_CAP = 5000;

const USER_RE = /^U[A-Z0-9]+$/;
const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
const SYSTEM_USERS = new Set(["USLACKBOT"]);

export interface ObserveUser {
  teamId: string;
  userId: string;
  tenantId?: string;
}
export interface ObserveChannel {
  teamId: string;
  channelId: string;
  tenantId?: string;
}

export interface FirstSightDeps {
  db?: () => DbClient;
  role?: () => string;
  /** Write the audit events of new records. Default: `emitDomainEvents`. */
  emit?: (events: readonly DomainEvent[], opts: { tenantId?: string }) => Promise<void>;
  /** Write the one burst summary. Default: `audit`. */
  summary?: (i: { tenantId?: string; count: number; windowMs: number }) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Writes run one at a time per process: one connection (sqlite, PGLite) cannot
 * interleave two transactions, and nothing here is latency sensitive.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Set while first sight writes its own audit events. */
const guard = new AsyncLocalStorage<true>();
export const insideFirstSight = (): boolean => guard.getStore() === true;

export interface FirstSight {
  observeSlackUser(i: ObserveUser): void;
  observeSlackChannel(i: ObserveChannel): void;
  /** Resolves when every write started so far has settled (tests, shutdown). */
  flush(): Promise<void>;
  /** Forget the LRU and the log-once memory. */
  reset(): void;
}

export function createFirstSight(deps: FirstSightDeps = {}): FirstSight {
  const getDb = deps.db ?? (() => globalDb);
  const role = deps.role ?? (() => env.role());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(`[domain] ${m}`));
  const emit =
    deps.emit ??
    (async (events, o) => {
      const { emitDomainEvents } = await import("../audit/domain");
      await emitDomainEvents(events, { ...(o.tenantId ? { tenantId: o.tenantId } : {}), actorId: "first-sight" });
    });
  const summary =
    deps.summary ??
    (async (i) => {
      const { audit } = await import("../audit/index");
      await audit({
        ...(i.tenantId ? { tenantId: i.tenantId } : {}),
        actorKind: "system",
        actorId: "first-sight",
        action: SUMMARY_ACTION,
        targetKind: "domain",
        summary: `first sight: more than ${BURST_LIMIT} new records in a minute (${i.count} so far); per-record events suppressed for the window`,
        details: { count: i.count, window_ms: i.windowMs },
      });
    });

  /** key -> time it was last confirmed. Map order is recency (re-set on hit). */
  const lru = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  const logged = new Set<string>();
  const pending = new Set<Promise<void>>();
  let windowStart = 0;
  let windowCount = 0;
  let windowSummarised = false;

  const cached = (key: string): boolean => {
    const at = lru.get(key);
    if (at === undefined) return false;
    if (now() - at > RECHECK_MS) {
      lru.delete(key);
      return false;
    }
    return true;
  };
  const remember = (key: string): void => {
    lru.delete(key);
    lru.set(key, now());
    while (lru.size > LRU_CAP) lru.delete(lru.keys().next().value as string);
  };
  const logOnce = (key: string, e: unknown): void => {
    if (logged.has(key)) return;
    if (logged.size >= LOG_CAP) logged.clear();
    logged.add(key);
    log(`first sight ${key}: ${e instanceof Error ? e.message : String(e)}`);
  };

  /** Audit new records, subject to the per-minute burst limit. Never throws. */
  async function record(events: readonly DomainEvent[], tenantId: string | undefined): Promise<void> {
    if (events.length === 0) return;
    const t = now();
    if (t - windowStart >= BURST_WINDOW_MS) {
      windowStart = t;
      windowCount = 0;
      windowSummarised = false;
    }
    windowCount += 1;
    try {
      if (windowCount <= BURST_LIMIT) {
        await guard.run(true, () => emit(events, { tenantId }));
      } else if (!windowSummarised) {
        windowSummarised = true;
        await guard.run(true, () => summary({ tenantId, count: windowCount, windowMs: BURST_WINDOW_MS }));
      }
    } catch (e) {
      logOnce("audit", e);
    }
  }

  function start(key: string, tenantId: string | undefined, write: (c: DbClient) => Promise<DomainEvent[]>): void {
    if (role() === "node" || insideFirstSight()) return;
    if (cached(key) || inflight.has(key)) return;
    const run = async (): Promise<void> => {
      try {
        const c = getDb();
        const events = await c.transaction((tx) => write(tx));
        remember(key);
        await record(events, tenantId);
      } catch (e) {
        logOnce(key, e);
      }
    };
    const p: Promise<void> = (queue = queue.then(run, run) as Promise<void>).finally(() => {
      inflight.delete(key);
      pending.delete(p);
    });
    inflight.set(key, p);
    pending.add(p);
    trackFirstSight(p);
  }

  return {
    observeSlackUser(i) {
      try {
        if (!i || !i.teamId || !USER_RE.test(i.userId ?? "") || SYSTEM_USERS.has(i.userId)) return;
        start(`slack/${i.teamId}/user/${i.userId}`, i.tenantId, async (c) => {
          const r = await Domain.ensureBinding(
            { service: "slack", kind: "user", workspace: i.teamId, value: i.userId, state: "observed", source: "first-sight" },
            c,
          );
          return r.events;
        });
      } catch (e) {
        logOnce("observeSlackUser", e);
      }
    },
    observeSlackChannel(i) {
      try {
        if (!i || !i.teamId || !CHANNEL_RE.test(i.channelId ?? "")) return;
        start(`slack/${i.teamId}/channel/${i.channelId}`, i.tenantId, async (c) => {
          const r = await Domain.ensureBoundary(
            { service: "slack", workspace: i.teamId, value: i.channelId, kind: i.channelId.startsWith("D") ? "dm" : "channel", state: "observed" },
            c,
          );
          return r.events;
        });
      } catch (e) {
        logOnce("observeSlackChannel", e);
      }
    },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
    reset() {
      lru.clear();
      logged.clear();
      windowStart = 0;
      windowCount = 0;
      windowSummarised = false;
    },
  };
}

let shared: FirstSight | undefined;
const sight = (): FirstSight => (shared ??= createFirstSight());

export const observeSlackUser = (i: ObserveUser): void => sight().observeSlackUser(i);
export const observeSlackChannel = (i: ObserveChannel): void => sight().observeSlackChannel(i);
export const flushFirstSight = (): Promise<void> => sight().flush();
export const resetFirstSight = (): void => sight().reset();

// ---------------------------------------------------------------------------
// Audit seam: workspace for an audit event, which carries no team id.
// ---------------------------------------------------------------------------

let liveTeams: () => readonly string[] = () => [];
/** The gateway registers its connected workspaces at boot (after Slack auth). */
export function setLiveWorkspaces(fn: () => readonly string[]): void {
  liveTeams = fn;
}

const sessionTeam = new Map<string, string>();

async function workspaceForAudit(sessionId: string | null | undefined): Promise<string | null> {
  if (sessionId) {
    const hit = sessionTeam.get(sessionId);
    if (hit) return hit;
    const row = await globalDb.one<{ slack_team_id: string | null }>("SELECT slack_team_id FROM sessions WHERE id = ?", [sessionId]);
    if (row?.slack_team_id) {
      if (sessionTeam.size >= LRU_CAP) sessionTeam.clear();
      sessionTeam.set(sessionId, row.slack_team_id);
      return row.slack_team_id;
    }
  }
  const teams = liveTeams();
  return teams.length === 1 ? teams[0]! : null;
}

/**
 * Called by the audit writer after a row is written. Observes the Slack user
 * actor and the channel of an event. Synchronous for the common case (a key
 * already in the LRU costs one Map lookup after the workspace is known);
 * never throws; does nothing for events first sight itself wrote.
 */
export function observeFromAudit(input: {
  tenantId?: string;
  actorKind: string;
  actorId: string;
  sessionId?: string | null;
  channelId?: string | null;
}): void {
  try {
    if (insideFirstSight() || env.role() === "node") return;
    const userOk = input.actorKind === "slack_user" && USER_RE.test(input.actorId) && !SYSTEM_USERS.has(input.actorId);
    const channelOk = !!input.channelId && CHANNEL_RE.test(input.channelId);
    if (!userOk && !channelOk) return;
    void trackFirstSight(workspaceForAudit(input.sessionId)
      .then((teamId) => {
        if (!teamId) return;
        if (userOk) observeSlackUser({ teamId, userId: input.actorId, tenantId: input.tenantId });
        if (channelOk) observeSlackChannel({ teamId, channelId: input.channelId!, tenantId: input.tenantId });
      })
      .catch(() => {}));
  } catch {
    /* never into the caller */
  }
}
