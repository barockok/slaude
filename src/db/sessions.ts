import { db, type SessionRow } from "./schema";
import type { DbClient } from "./client";
import { randomUUID } from "node:crypto";
import { observeSlackChannel } from "../domain/first-sight";
import { boundaryForCached, locatorOf } from "../domain/boundary-for";
import { env } from "../config/env";
import { checkRow } from "../domain/boundary-check";

export type ThreadKey = {
  team_id: string;
  channel_id: string;
  thread_ts: string;
  /** Which persona owns this session. Defaults to 'default' (the single-bot mode). */
  persona_id?: string;
};

/**
 * `boundary_id` and `locator` (slice D) are internal: they are read inside this
 * module (the in-row parity check) and by the fill and the check command through
 * their own queries, and never leave it. Every row this module returns to a caller
 * is the shape rc.21 returned, so REST, the console and the node store are unchanged.
 */
type RawRow = SessionRow & { boundary_id?: string | null; locator?: string | null; thread_head_at?: number | string | null };
function publicRow<T extends RawRow | null>(row: T): T {
  if (!row) return row;
  const { boundary_id: _b, locator: _l, thread_head_at: _h, ...rest } = row as RawRow;
  return rest as unknown as T;
}

export async function findByThread(k: ThreadKey): Promise<SessionRow | null> {
  const personaId = k.persona_id ?? "default";
  const row = await db.one<RawRow>(
    `SELECT * FROM sessions
     WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       AND persona_id = ?`,
    [k.team_id, k.channel_id, k.thread_ts, personaId],
  );
  checkRow("find_by_thread", row);
  return publicRow(row);
}

/** Find the most-recently-updated session for a thread regardless of persona.
 *  Used for "is there any session to populate?" checks (engagement restore,
 *  mention-only recording) where the caller doesn't know which persona to ask for. */
export async function findAnyByThread(k: Omit<ThreadKey, "persona_id">): Promise<SessionRow | null> {
  const row = await db.one<RawRow>(
    `SELECT * FROM sessions
     WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [k.team_id, k.channel_id, k.thread_ts],
  );
  checkRow("find_any_by_thread", row);
  return publicRow(row);
}

/** The Slack team of the most recent session in a thread, by channel and thread only (channel ids are workspace-unique). */
export async function teamForThread(channelId: string, threadTs: string): Promise<string | null> {
  const row = await db.one<{ slack_team_id: string | null }>(
    `SELECT slack_team_id FROM sessions WHERE slack_channel_id = ? AND slack_thread_ts = ? ORDER BY updated_at DESC LIMIT 1`,
    [channelId, threadTs],
  );
  return row?.slack_team_id ?? null;
}

/**
 * Create the session row for a conversation thread. Every session is on the
 * Slack surface today (team, channel, thread); the panel reads that from
 * surfaceOfSession (src/gateway/core/surface.ts), not from a literal.
 */
export async function createForThread(args: {
  thread: ThreadKey;
  model: string;
  working_dir: string;
  title?: string;
  permission_mode?: string;
}): Promise<SessionRow> {
  const id = randomUUID();
  const now = Date.now();
  const personaId = args.thread.persona_id ?? "default";
  // Domain sessions, slice D: the boundary and the opaque thread key ride in the
  // same INSERT when the boundary is already cached; NULL otherwise (the late
  // fill after first sight, or the periodic fill, completes the row). Cache only:
  // nothing is awaited and nothing can fail here, so a slow boundaries table
  // never delays or breaks a session create. The Slack columns stay the key.
  const boundary = boundaryForCached(args.thread.team_id, args.thread.channel_id);
  const locator = boundary ? locatorOf(args.thread.thread_ts) : null;
  // A concurrent creator of the same thread (another replica, the cron scheduler beside an inbound event) is
  // not an error: ON CONFLICT DO NOTHING lets the loser read the winner's row instead of raising a unique
  // violation, so a burst of creates never churns errors through the connection pool.
  const inserted = await db.run(
    `INSERT INTO sessions
     (id, created_at, updated_at, title, model, working_dir, status,
      claude_started, slack_team_id, slack_channel_id, slack_thread_ts,
      permission_mode, persona_id, boundary_id, locator)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slack_team_id, slack_channel_id, slack_thread_ts, persona_id) DO NOTHING`,
    [
      id,
      now,
      now,
      args.title ?? null,
      args.model,
      args.working_dir,
      args.thread.team_id,
      args.thread.channel_id,
      args.thread.thread_ts,
      args.permission_mode ?? "default",
      personaId,
      boundary ? boundary.id : null,
      locator,
    ],
  );
  // First sight: this is the one place a session row is created (the node has no store that creates rows).
  observeSlackChannel({ teamId: args.thread.team_id, channelId: args.thread.channel_id });
  // The row exists (we wrote it, or the winner did): read it with a short bounded retry and, failing that,
  // raise a typed error. A create never hands its caller null.
  const created =
    inserted.changes > 0
      ? await readBounded(() => db.one<RawRow>(`SELECT * FROM sessions WHERE id = ?`, [id]))
      : await readBounded(() =>
          db.one<RawRow>(`SELECT * FROM sessions WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ? AND persona_id = ?`, [
            args.thread.team_id,
            args.thread.channel_id,
            args.thread.thread_ts,
            personaId,
          ]),
        );
  if (!created) throw new SessionCreateError(args.thread.channel_id, args.thread.thread_ts);
  checkRow("create", created);
  return publicRow(created);
}

/** Raised when a session row that was just written (or lost a create race to) cannot be read back. */
export class SessionCreateError extends Error {
  constructor(channel: string, thread: string) {
    super(`session create: the row for ${channel}/${thread} could not be read back`);
    this.name = "SessionCreateError";
  }
}

/** Up to three reads (now, then after 25 ms and 75 ms): a row that was just committed may not be visible to the next pooled connection at once. */
async function readBounded<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (const wait of [0, 25, 75]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const row = await read();
    if (row) return row;
  }
  return null;
}

export async function findById(id: string): Promise<SessionRow | null> {
  return publicRow(await db.one<RawRow>(`SELECT * FROM sessions WHERE id = ?`, [id]));
}

export interface ListSessionsOpts {
  persona?: string;
  status?: string;
  /** Postgres-only column (P1 migration); ignored on sqlite where it is absent. */
  tenant?: string;
  limit?: number;
  offset?: number;
}

/**
 * List sessions newest-first for the operator control panel — the one
 * list-all accessor (the rest of this repo is single-row lookups). Optional
 * equality filters on persona / status / tenant. `tenant` filters only when
 * the dialect actually carries a `tenant_id` column (Postgres); on sqlite the
 * filter is dropped rather than erroring on an unknown column.
 *
 * Rows come back as `SessionRow` plus any extra columns the driver returns
 * (e.g. `tenant_id` on Postgres) — the panel passes those through dynamically,
 * mirroring the `/v1` session view.
 */
export async function listSessions(o: ListSessionsOpts = {}): Promise<SessionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.persona) {
    where.push("persona_id = ?");
    params.push(o.persona);
  }
  if (o.status) {
    where.push("status = ?");
    params.push(o.status);
  }
  if (o.tenant && db.dialect === "pg") {
    where.push("tenant_id = ?");
    params.push(o.tenant);
  }
  const limit = Number.isInteger(o.limit) && o.limit! > 0 ? Math.min(o.limit!, 500) : 100;
  const offset = Number.isInteger(o.offset) && o.offset! >= 0 ? o.offset! : 0;
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);
  const rows = await db.query<RawRow>(
    `SELECT * FROM sessions ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map((r) => publicRow(r));
}

/** How many sessions have this status (e.g. "running": a turn in flight). */
export async function countByStatus(status: string): Promise<number> {
  const r = await db.one<{ n: number | string }>(`SELECT COUNT(*) AS n FROM sessions WHERE status = ?`, [status]);
  return Number(r?.n ?? 0);
}

export async function markStarted(id: string): Promise<void> {
  await db.run(`UPDATE sessions SET claude_started = 1, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

/**
 * Sessions created before this change (2026-11-17T06:51:16Z, the time the release candidate was tagged) that
 * had already started a query had their first turn before the thread head existed. They carry a NULL
 * marker, and a head in the middle of their conversation would be wrong, so at claim time such a row
 * is treated as already past its first turn: the marker is claimed and nothing is injected. Sessions
 * from before the epoch that never started still get a head on their first real turn. During a rolling
 * deploy a session first started by an older replica after the epoch looks new here and gets a head
 * on its next turn on a newer one.
 */
export const THREAD_HEAD_EPOCH_MS = 1794898276000;

/** Whether a session row predates the thread head and had already run its first turn. */
export const hadFirstTurnBeforeThreadHead = (row: { created_at: number | string; claude_started: number | boolean }): boolean =>
  Number(row.created_at) < THREAD_HEAD_EPOCH_MS && Number(row.claude_started) === 1;

/** Whether the session's thread head marker is still unclaimed (a read; the claim is the compare-and-set). */
export async function threadHeadPending(id: string): Promise<boolean> {
  const r = await db.one<{ thread_head_at: number | string | null }>(`SELECT thread_head_at FROM sessions WHERE id = ?`, [id]);
  return !!r && (r.thread_head_at === null || r.thread_head_at === undefined);
}

/**
 * Claim the session's thread head (rc.28): true for exactly one caller, once per session. Compare-and-set
 * on `thread_head_at IS NULL`, so two quick first messages cannot both inject the head, and the answer
 * outlives any purge (the marker is on the session row, unlike a seen-events row).
 * `client` is a seam for the migration test; the gateway uses `claimThreadHead`.
 */
export async function claimThreadHeadOn(client: DbClient, id: string, at: number = Date.now()): Promise<boolean> {
  const r = await client.run(`UPDATE sessions SET thread_head_at = ? WHERE id = ? AND thread_head_at IS NULL`, [at, id]);
  return (r.changes ?? 0) > 0;
}

export const claimThreadHead = (id: string, at: number = Date.now()): Promise<boolean> => claimThreadHeadOn(db, id, at);

/** Give the marker back after a turn that claimed it never started: only if it still holds this claim's timestamp. */
export async function releaseThreadHeadOn(client: DbClient, id: string, at: number): Promise<boolean> {
  const r = await client.run(`UPDATE sessions SET thread_head_at = NULL WHERE id = ? AND thread_head_at = ?`, [id, at]);
  return (r.changes ?? 0) > 0;
}

export const releaseThreadHead = (id: string, at: number): Promise<boolean> => releaseThreadHeadOn(db, id, at);

export async function setStatus(id: string, status: string): Promise<void> {
  await db.run(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    Date.now(),
    id,
  ]);
}

export async function clearStarted(id: string): Promise<void> {
  // A restart with no transcript is a new first turn: the thread head is owed again.
  await db.run(`UPDATE sessions SET claude_started = 0, thread_head_at = NULL, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

/** Record the Slack app (api_app_id) the thread arrives through (D1.2), so
 *  turns with no inbound event (the operator panel) post as that app. */
export async function setSlackApp(id: string, apiAppId: string): Promise<void> {
  await db.run(`UPDATE sessions SET slack_app_id = ?, updated_at = ? WHERE id = ?`, [apiAppId, Date.now(), id]);
}

/** Persist per-thread engagement so a disengage (user @mentioned a colleague)
 *  survives both the next-message restore path and gateway restarts. */
export async function setEngaged(id: string, engaged: boolean): Promise<void> {
  await db.run(`UPDATE sessions SET engaged = ?, updated_at = ? WHERE id = ?`, [
    engaged ? 1 : 0,
    Date.now(),
    id,
  ]);
}

/** Flip engagement for EVERY persona session in a thread — a colleague-mention
 *  disengages the bot and all personas at once (sessions.engaged is the only
 *  engagement source; there is no in-memory set anymore). */
export async function setEngagedForThread(
  k: Omit<ThreadKey, "persona_id">,
  engaged: boolean,
): Promise<void> {
  await db.run(
    `UPDATE sessions SET engaged = ?, updated_at = ?
     WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?`,
    [engaged ? 1 : 0, Date.now(), k.team_id, k.channel_id, k.thread_ts],
  );
}

export async function setPermissionMode(id: string, mode: string): Promise<void> {
  await db.run(`UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?`, [
    mode,
    Date.now(),
    id,
  ]);
}

export async function setModel(id: string, model: string): Promise<void> {
  await db.run(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`, [
    model,
    Date.now(),
    id,
  ]);
}

/**
 * Sessions of these personas touched at or after `sinceMs` (every turn bumps
 * updated_at through setStatus), most recently touched first: the background
 * nightly review's candidates for a day's conversations. Bounded by `limit`,
 * which keeps the active ones.
 */
export async function updatedSince(personaIds: readonly string[], sinceMs: number, limit = 2000): Promise<SessionRow[]> {
  if (personaIds.length === 0) return [];
  const marks = personaIds.map(() => "?").join(", ");
  const rows = await db.query<RawRow>(
    `SELECT * FROM sessions WHERE persona_id IN (${marks}) AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`,
    [...personaIds, sinceMs, limit],
  );
  return rows.map((r) => publicRow(r));
}

/**
 * The Slack app a persona's threads arrive through: its most recently
 * touched session that recorded an app id, else its most recent one (team
 * only). Only this persona's sessions are read.
 */
export async function latestAppOf(personaId: string): Promise<{ apiAppId: string | null; teamId: string | null } | null> {
  const row = await db.one<{ slack_app_id: string | null; slack_team_id: string | null }>(
    `SELECT slack_app_id, slack_team_id FROM sessions WHERE persona_id = ?
      ORDER BY CASE WHEN slack_app_id IS NULL THEN 1 ELSE 0 END, updated_at DESC LIMIT 1`,
    [personaId],
  );
  return row ? { apiAppId: row.slack_app_id ?? null, teamId: row.slack_team_id ?? null } : null;
}

/**
 * Retire a channel session: its key is freed so the next message starts a new one; the row and history stay.
 * One statement rewrites the Slack thread column and the locator together, so the retired row can never
 * share `(boundary_id, locator, persona_id)` with the new `channel:<id>` session. A row that has no
 * boundary yet keeps a NULL locator: the fill derives it from the already rewritten thread column.
 */
export async function archiveChannelSession(id: string, channelId: string, now: number): Promise<void> {
  const key = `channel-archived:${channelId}:${now}`;
  await db.run(`UPDATE sessions SET slack_thread_ts = ?, locator = CASE WHEN boundary_id IS NULL THEN locator ELSE ? END, updated_at = ? WHERE id = ?`, [
    key,
    key,
    now,
    id,
  ]);
}

/** The most rows one late fill updates; the periodic fill takes the rest. */
export const LATE_FILL_LIMIT = 500;

/**
 * After first sight created or found the boundary of a channel: complete the
 * sessions of that channel (and workspace) that were written before the
 * boundary was known. Compare-and-set on `boundary_id IS NULL`, so a filled row
 * is never overwritten, bounded, and never throws (a failure is left to the
 * periodic fill). Rows with no workspace are left to the periodic fill, which
 * decides which workspace they belong to. Returns how many rows it filled.
 */
export async function fillBoundaryForChannel(teamId: string, channelId: string, boundaryId: string): Promise<number> {
  try {
    if (!env.boundary.write() || env.role() === "node" || !teamId || !channelId || !boundaryId) return 0;
    // Ids in a fixed order, then one statement-level compare-and-set per row: no multi-row lock hold, and two
    // fills (or a fill and a writer) can never wait on each other in opposite orders.
    const ids = await db.query<{ id: string }>(
      `SELECT id FROM sessions
        WHERE slack_team_id = ? AND slack_channel_id = ? AND boundary_id IS NULL
          AND slack_thread_ts IS NOT NULL AND slack_thread_ts <> ''
        ORDER BY id LIMIT ${LATE_FILL_LIMIT}`,
      [teamId, channelId],
    );
    let filled = 0;
    for (const { id } of ids) {
      const r = await db.run(
        `UPDATE sessions SET boundary_id = ?, locator = slack_thread_ts
          WHERE id = ? AND boundary_id IS NULL AND slack_team_id = ? AND slack_channel_id = ?
            AND slack_thread_ts IS NOT NULL AND slack_thread_ts <> ''`,
        [boundaryId, id, teamId, channelId],
      );
      filled += r.changes;
    }
    return filled;
  } catch {
    return 0;
  }
}

/**
 * Remove heartbeat wakes' session rows older than `beforeMs`, with what is keyed
 * on them. A wake is one fresh session, never resumed, so they would only pile up.
 * Never a session of a real thread: the key is the wake's synthetic `wake:` thread.
 * The CLI's transcript files stay. Returns how many were removed.
 */
export async function deleteWakeSessionsBefore(beforeMs: number): Promise<number> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM sessions WHERE slack_thread_ts LIKE 'wake:%' AND updated_at < ?`, [beforeMs]);
  for (const { id } of rows) {
    for (const table of ["pending_gates", "memory_turns", "memory_facts", "thread_activity"]) {
      await db.run(`DELETE FROM ${table} WHERE session_id = ?`, [id]);
    }
    await db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  }
  return rows.length;
}
