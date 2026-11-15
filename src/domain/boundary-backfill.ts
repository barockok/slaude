/**
 * Boundary fill (domain sessions, slice D): completes `boundary_id` and
 * `locator` on the rows the writers could not (rows from before the columns,
 * rows written while the boundary was unknown, rows written by an rc.21
 * replica), one table at a time, in keyset pages.
 *
 * Guarantees:
 *  - Compare-and-set only: `UPDATE ... WHERE <key> AND boundary_id IS NULL`. A
 *    filled row is never overwritten, a second runner or a live writer changes
 *    zero rows, and nothing here ever repoints a row.
 *  - Never creates a boundary. An eligible `(team, channel)` with no boundary is
 *    handed to first sight (`observeSlackChannel`), which creates it under its
 *    own caps; the next run fills the rows. Never workspace ''.
 *  - The team is the row's own team column; a row without one is placed in the
 *    tenant's single workspace, else it is `ambiguous` or `no_workspace` and is
 *    never written. Channel ids first sight would never record are `ineligible`
 *    and excluded from the gate.
 *  - Bounded: pages of `pageSize`, at most `maxRows` rows written per run (or
 *    per table for the boot stage), one transaction per page. `audit_events` is
 *    never read or written.
 *  - Reads the cron rule from `cronLocator`; every other locator is the row's
 *    thread column verbatim.
 */
import { cronLocator } from "../db/boundary-columns";
import type { DbClient } from "../db/schema";
import { db as globalDb } from "../db/schema";
import { env } from "../config/env";
import { m } from "../metrics";
import { CHANNEL_RE } from "./boundary-for";
import { observeSlackChannel } from "./first-sight";

/** Advisory-lock key of the periodic fill: ('SLAU' as int32, 3). Distinct from the reconciler's. */
export const BOUNDARY_FILL_LOCK_KEY: [number, number] = [0x534c4155, 3];
export const FILL_PAGE_SIZE = 500;
const DEFAULT_TENANT = "default";

export interface BoundaryTableReport {
  filled: number;
  /** Rows already carrying a boundary (counted, not scanned). */
  existing: number;
  /** Channel id first sight would never record: no boundary will exist, excluded from the gate. */
  ineligible: number;
  /** A row without a team in a tenant with more than one workspace. */
  ambiguous: number;
  /** A row without a team in a tenant with no known workspace. */
  no_workspace: number;
  /** Eligible, placed, and no boundary exists yet. */
  no_boundary: number;
  /** Channels handed to first sight this run (distinct team and channel). */
  handed_to_first_sight: number;
  /** A row with no thread key to use as a locator. */
  no_locator: number;
  /** A filled row whose locator no longer matched its thread key (an rc.21 writer or a rollback rewrote the key); the locator was recomputed. */
  repaired: number;
  /** A row with no team of its own, placed in the single workspace, whose boundary does not exist: reported, never handed to first sight. */
  team_unknown: number;
}

export type BoundaryColumnsReport = Record<string, BoundaryTableReport>;

const emptyTable = (): BoundaryTableReport => ({ filled: 0, existing: 0, ineligible: 0, ambiguous: 0, no_workspace: 0, no_boundary: 0, handed_to_first_sight: 0, no_locator: 0, repaired: 0, team_unknown: 0 });

export interface Spec {
  table: string;
  /** Primary key columns, in order (keyset order). */
  pk: string[];
  /** The row's own team column, when the table has one. */
  team: string | null;
  channel: string;
  /** Thread column the locator is read from; null for the boundary-only tables. */
  thread: string | null;
  /** Extra filter on the scan. */
  where?: string;
  /** Extra columns the locator rule needs. */
  extra?: string[];
}

/** Every table the fill completes, in the plan's order (sessions last). */
export const SPECS: Spec[] = [
  { table: "one_on_one_locks", pk: ["channel_id", "thread_ts"], team: "team_id", channel: "channel_id", thread: "thread_ts" },
  { table: "mention_only_threads", pk: ["channel_id", "thread_ts"], team: null, channel: "channel_id", thread: "thread_ts" },
  { table: "ignores", pk: ["id"], team: null, channel: "channel_id", thread: "thread_ts", where: "target_type = 'thread'" },
  { table: "cron_jobs", pk: ["id"], team: "slack_team_id", channel: "slack_channel_id", thread: "slack_thread_ts", extra: ["target"] },
  { table: "commitments", pk: ["agent_id", "source", "slug"], team: "team_id", channel: "channel_id", thread: "thread_ts" },
  { table: "env_bindings", pk: ["channel_id", "thread_ts"], team: null, channel: "channel_id", thread: "thread_ts" },
  { table: "proactive_posts", pk: ["id"], team: "team_id", channel: "channel_id", thread: null },
  { table: "channel_wake_state", pk: ["agent_id", "channel_id"], team: null, channel: "channel_id", thread: null },
  { table: "sessions", pk: ["id"], team: "slack_team_id", channel: "slack_channel_id", thread: "slack_thread_ts" },
];

export type Place = (tenant: string) => { ws: string } | { reason: "ambiguous" | "no_workspace" };

/** Workspaces per tenant: Postgres reads `slack_apps`, sqlite the live Slack auth. */
export async function loadWorkspaces(c: DbClient, liveTeamIds?: () => Promise<string[]> | string[]): Promise<Place> {
  const ws = new Map<string, Set<string>>();
  const add = (tenant: string, team: string) => {
    if (!team) return;
    const s = ws.get(tenant) ?? new Set<string>();
    s.add(team);
    ws.set(tenant, s);
  };
  if (c.dialect === "pg") {
    for (const r of await c.query<{ tenant_id: string; team_id: string }>("SELECT DISTINCT tenant_id, team_id FROM slack_apps")) add(r.tenant_id, r.team_id);
  } else if (liveTeamIds) {
    for (const t of await liveTeamIds()) add(DEFAULT_TENANT, t);
  }
  return (tenant) => {
    const s = ws.get(tenant);
    if (!s || s.size === 0) return { reason: "no_workspace" };
    if (s.size > 1) return { reason: "ambiguous" };
    return { ws: [...s][0]! };
  };
}

export interface FillOptions {
  dryRun?: boolean;
  pageSize?: number;
  /** Rows written at most. Across all tables unless `perTable`. */
  maxRows: number;
  perTable?: boolean;
  place: Place;
  /** Tables to fill (default all). */
  tables?: string[];
  /** Observe a channel without a boundary. Default: first sight. Not called in a dry run. */
  handOff?: (team: string, channel: string) => void;
  /** Stop between pages when true. */
  stop?: () => boolean;
  /** Rows examined at most across the call (the scan budget). Default unlimited. */
  maxExamine?: number;
  /** Per table and phase, the last primary key examined: survives across calls so a capped scan resumes where it stopped and wraps after a full pass. */
  cursors?: Map<string, unknown[]>;
  /** Count complete rows per table for the report (default true; the periodic tick turns it off). */
  counts?: boolean;
}

const count = (table: string, outcome: string, n = 1): void => {
  if (n <= 0) return;
  try {
    m.boundaryFillTotal.inc({ table, outcome }, n);
  } catch {
    /* metrics never fail the fill */
  }
};

/** Tables of the fill that carry a `tenant_id` (Postgres only), in one query. */
async function tenantTables(c: DbClient): Promise<Set<string>> {
  if (c.dialect !== "pg") return new Set();
  const rows = await c.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND table_name IN (${SPECS.map(() => "?").join(", ")})`,
    SPECS.map((x) => x.table),
  );
  return new Set(rows.map((r) => r.table_name));
}

/** The session key a cron job runs under, in SQL (mirrors `cronLocator`). */
const CRON_LOCATOR_SQL = `CASE WHEN target = 'channel' THEN 'cron:' || id WHEN slack_thread_ts IS NOT NULL AND slack_thread_ts <> '' THEN slack_thread_ts ELSE 'cron:' || id END`;

/** The locator of a row, computed by the statement that writes it so a /new between the scan and the write cannot leave a stale one. */
const locatorSql = (spec: Spec): string | null => (spec.table === "cron_jobs" ? CRON_LOCATOR_SQL : spec.thread);

/** True when the row has a thread key to derive a locator from (cron jobs always do). */
const hasKeySql = (spec: Spec): string => (spec.table === "cron_jobs" || !spec.thread ? "1 = 1" : `${spec.thread} IS NOT NULL AND ${spec.thread} <> ''`);

/**
 * Fill the NULL rows of the given tables, then repair stale locators. Idempotent:
 * a second run over the same data changes nothing. Each row is its own
 * statement-level compare-and-set (no page transaction, no long lock hold), the
 * locator is computed by that statement from the thread column, and the statement
 * also pins the channel (and the team when the row has one) the boundary was
 * resolved from. Returns the per-table report.
 */
export async function fillBoundaryColumns(c: DbClient, o: FillOptions): Promise<BoundaryColumnsReport> {
  const pageSize = o.pageSize ?? FILL_PAGE_SIZE;
  const handOff = o.handOff ?? ((team, channel) => observeSlackChannel({ teamId: team, channelId: channel }));
  const report: BoundaryColumnsReport = {};
  let budget = o.maxRows;
  let examineLeft = o.maxExamine ?? Number.POSITIVE_INFINITY;
  const boundaryCache = new Map<string, string | null>();
  const handed = new Set<string>();
  const withTenant = await tenantTables(c);
  const counts = o.counts !== false;

  const boundaryOf = async (team: string, channel: string): Promise<string | null> => {
    const key = `${team}|${channel}`;
    if (boundaryCache.has(key)) return boundaryCache.get(key)!;
    const r = await c.one<{ id: string }>("SELECT id FROM boundaries WHERE service = 'slack' AND workspace = ? AND value = ?", [team, channel]);
    boundaryCache.set(key, r?.id ?? null);
    return r?.id ?? null;
  };
  const live = (): boolean => budget > 0 && examineLeft > 0 && !(o.stop?.() ?? false);

  for (const spec of SPECS) {
    if (o.tables && !o.tables.includes(spec.table)) continue;
    const rep = (report[spec.table] = emptyTable());
    if (o.perTable) budget = o.maxRows;
    const T = withTenant.has(spec.table) ? "tenant_id" : `'${DEFAULT_TENANT}'`;
    const locExpr = locatorSql(spec);
    const cols = [
      `${T} AS tenant`,
      spec.team ? `${spec.team} AS team` : `NULL AS team`,
      `${spec.channel} AS channel`,
      spec.thread ? `${spec.thread} AS thread` : `NULL AS thread`,
      spec.extra?.includes("target") ? `target AS target` : `NULL AS target`,
      "locator AS locator",
      ...spec.pk.map((k, i) => `${k} AS pk${i}`),
    ].join(", ").replace("locator AS locator", spec.thread ? "locator AS locator" : "NULL AS locator");
    const tuple = spec.pk.length > 1 ? `(${spec.pk.join(", ")})` : spec.pk[0]!;
    const marks = spec.pk.length > 1 ? `(${spec.pk.map(() => "?").join(", ")})` : "?";
    const pkWhere = spec.pk.map((k) => `${k} = ?`).join(" AND ");

    /** One keyset pass over `filter`; `each` handles a row. The cursor lives across ticks when given. */
    const pass = async (phase: "fill" | "repair", filter: string, each: (raw: Record<string, unknown>) => Promise<void>): Promise<void> => {
      const ck = `${spec.table}:${phase}`;
      let after: unknown[] | null = o.cursors?.get(ck) ?? null;
      while (live()) {
        const page: Array<Record<string, unknown>> = await c.query(
          `SELECT ${cols} FROM ${spec.table}
            WHERE ${filter} ${spec.where ? `AND ${spec.where}` : ""} ${after ? `AND ${tuple} > ${marks}` : ""}
            ORDER BY ${spec.pk.join(", ")} LIMIT ?`,
          [...(after ?? []), pageSize],
        );
        if (page.length === 0) {
          o.cursors?.delete(ck); // a full pass: wrap around
          return;
        }
        after = spec.pk.map((_, i) => page[page.length - 1]![`pk${i}`]);
        examineLeft -= page.length;
        for (const raw of page) {
          if (budget <= 0) break;
          await each(raw);
        }
        if (page.length < pageSize) {
          o.cursors?.delete(ck);
          return;
        }
        o.cursors?.set(ck, after);
      }
    };

    // 1. Fill the NULL rows.
    await pass("fill", "boundary_id IS NULL", async (raw) => {
      const tenant = String(raw.tenant);
      const ownTeam = (raw.team as string | null) || null;
      const channel = (raw.channel as string | null) || null;
      const thread = (raw.thread as string | null) || null;
      const pk = spec.pk.map((_, i) => raw[`pk${i}`]);
      if (!channel || !CHANNEL_RE.test(channel)) {
        rep.ineligible++;
        return;
      }
      let team = ownTeam;
      if (!team) {
        const p = o.place(tenant);
        if ("reason" in p) {
          rep[p.reason]++;
          return;
        }
        team = p.ws;
      }
      if (spec.thread && spec.table !== "cron_jobs" && !thread) {
        rep.no_locator++;
        return;
      }
      const boundaryId = await boundaryOf(team, channel);
      if (!boundaryId) {
        // Only a row that names its own workspace may make first sight create a boundary: a placed one could
        // belong to a workspace that was connected before (a fabricated boundary would outlive the doubt).
        if (!ownTeam) {
          rep.team_unknown++;
          return;
        }
        rep.no_boundary++;
        const key = `${team}|${channel}`;
        if (!handed.has(key)) {
          handed.add(key);
          rep.handed_to_first_sight++;
          if (!o.dryRun) {
            try {
              handOff(team, channel);
            } catch {
              /* first sight never throws, but a fill must not either */
            }
          }
        }
        return;
      }
      if (o.dryRun) {
        rep.filled++;
        budget--;
        return;
      }
      const set = locExpr ? `boundary_id = ?, locator = ${locExpr}` : "boundary_id = ?";
      const teamGuard = spec.team ? (ownTeam ? ` AND ${spec.team} = ?` : ` AND ${spec.team} IS NULL`) : "";
      const r = await c.run(
        `UPDATE ${spec.table} SET ${set} WHERE ${pkWhere} AND boundary_id IS NULL AND ${spec.channel} = ?${teamGuard} AND ${hasKeySql(spec)}`,
        [boundaryId, ...pk, channel, ...(spec.team && ownTeam ? [ownTeam] : [])] as never,
      );
      const n = r.changes ?? 0;
      rep.filled += n;
      budget -= n;
    });

    // 2. Repair a locator an rc.21 replica (or a rollback) left stale by rewriting the thread column alone.
    if (locExpr && live()) {
      await pass("repair", `boundary_id IS NOT NULL AND ${hasKeySql(spec)} AND (locator IS NULL OR locator <> ${locExpr})`, async (raw) => {
        const old = (raw.locator as string | null) ?? null;
        const pk = spec.pk.map((_, i) => raw[`pk${i}`]);
        if (o.dryRun) {
          rep.repaired++;
          budget--;
          return;
        }
        const r = await c.run(
          `UPDATE ${spec.table} SET locator = ${locExpr} WHERE ${pkWhere} AND boundary_id IS NOT NULL AND ${hasKeySql(spec)} AND ${old === null ? "locator IS NULL" : "locator = ?"}`,
          [...pk, ...(old === null ? [] : [old])] as never,
        );
        const n = r.changes ?? 0;
        rep.repaired += n;
        budget -= n;
      });
    }

    if (counts) {
      // Rows already complete, for the report: counted without reading them.
      const done = await c.one<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE boundary_id IS NOT NULL`);
      rep.existing = Number(done?.n ?? 0);
    }
    for (const [k, v] of Object.entries(rep)) if (k !== "existing") count(spec.table, k, v as number);
    if (!o.perTable && !live()) {
      // Out of rows or scan budget for this run: the remaining tables wait for the next tick.
      for (const rest of SPECS.slice(SPECS.indexOf(spec) + 1)) {
        if (o.tables && !o.tables.includes(rest.table)) continue;
        const r2 = (report[rest.table] = emptyTable());
        if (counts) {
          const n = await c.one<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${rest.table} WHERE boundary_id IS NOT NULL`);
          r2.existing = Number(n?.n ?? 0);
        }
      }
      break;
    }
  }
  return report;
}

export const totalFilled = (r: BoundaryColumnsReport): number => Object.values(r).reduce((n, t) => n + t.filled, 0);

// ---------------------------------------------------------------------------
// Periodic tick
// ---------------------------------------------------------------------------

/** Postgres uses an advisory lock; sqlite (one process) uses this in-process flag. */
let running = false;
/** Resume points of the periodic fill (this process). */
const cursors = new Map<string, unknown[]>();

export interface TickOptions {
  db?: DbClient;
  role?: () => string;
  liveTeamIds?: () => Promise<string[]> | string[];
  maxRows?: number;
  log?: (msg: string) => void;
  /** Passed to the fill (tests). */
  handOff?: FillOptions["handOff"];
  /** Resume points (default: this process's). */
  cursors?: Map<string, unknown[]>;
}

/** Forget the periodic fill's resume points (tests). */
export const resetBoundaryFillCursors = (): void => cursors.clear();

/**
 * One periodic fill tick. Does nothing on a node, when SLAUDE_BOUNDARY_WRITE is
 * off, or when another runner holds the lock (the next tick tries again). Never
 * throws. Returns the report, or null when it did not run.
 */
export async function boundaryFillTick(o: TickOptions = {}): Promise<BoundaryColumnsReport | null> {
  const log = o.log ?? ((msg: string) => console.log(`[domain] ${msg}`));
  if ((o.role ?? (() => env.role()))() === "node" || !env.boundary.write()) return null;
  if (running) return null;
  running = true;
  const c = o.db ?? globalDb;
  let unlock: (() => Promise<void>) | undefined;
  try {
    if (c.advisoryLock) {
      try {
        unlock = await c.advisoryLock(...BOUNDARY_FILL_LOCK_KEY, { timeoutMs: 1000 });
      } catch {
        return null; // another replica is filling; try again next tick
      }
    }
    const place = await loadWorkspaces(c, o.liveTeamIds);
    const maxRows = o.maxRows ?? env.boundary.fillMaxRows();
    // A bounded look at the table each tick (five times the write cap), resumed where it stopped; no COUNT scans.
    const report = await fillBoundaryColumns(c, { maxRows, maxExamine: maxRows * 5, cursors: o.cursors ?? cursors, counts: false, place, handOff: o.handOff });
    const n = totalFilled(report);
    if (n > 0) log(`boundary fill: ${n} row(s) completed`);
    return report;
  } catch (e) {
    console.warn(`[domain] boundary fill failed (retried next tick): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    await unlock?.().catch(() => {});
    running = false;
  }
}

/**
 * Start the periodic fill. Returns an async stop: it ends the timer, starts no
 * further tick, and waits for the tick in flight. A node, a zero interval and a
 * switched-off write do nothing. The timer never keeps the process alive.
 */
export function startBoundaryFill(o: TickOptions & { intervalMs?: number } = {}): () => Promise<void> {
  const interval = o.intervalMs ?? env.boundary.fillIntervalMs();
  if ((o.role ?? (() => env.role()))() === "node" || interval <= 0) return async () => {};
  let stopped = false;
  let inflight: Promise<unknown> | null = null;
  const t = setInterval(() => {
    if (stopped || inflight) return;
    inflight = boundaryFillTick(o).finally(() => {
      inflight = null;
    });
  }, interval);
  (t as { unref?: () => void }).unref?.();
  return async () => {
    stopped = true;
    clearInterval(t);
    await inflight?.catch(() => {});
  };
}
