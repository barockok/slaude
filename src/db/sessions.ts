import { db, type SessionRow } from "./schema";
import { randomUUID } from "node:crypto";

export type ThreadKey = {
  team_id: string;
  channel_id: string;
  thread_ts: string;
  /** Which persona owns this session. Defaults to 'default' (the single-bot mode). */
  persona_id?: string;
};

export function findByThread(k: ThreadKey): SessionRow | null {
  const personaId = k.persona_id ?? "default";
  const row = db
    .query(
      `SELECT * FROM sessions
       WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
         AND persona_id = ?`,
    )
    .get(k.team_id, k.channel_id, k.thread_ts, personaId) as SessionRow | null;
  return row ?? null;
}

/** Find the most-recently-updated session for a thread regardless of persona.
 *  Used for "is there any session to populate?" checks (engagement restore,
 *  mention-only recording) where the caller doesn't know which persona to ask for. */
export function findAnyByThread(k: Omit<ThreadKey, "persona_id">): SessionRow | null {
  const row = db
    .query(
      `SELECT * FROM sessions
       WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(k.team_id, k.channel_id, k.thread_ts) as SessionRow | null;
  return row ?? null;
}

export function createForThread(args: {
  thread: ThreadKey;
  model: string;
  working_dir: string;
  title?: string;
  permission_mode?: string;
}): SessionRow {
  const id = randomUUID();
  const now = Date.now();
  const personaId = args.thread.persona_id ?? "default";
  db.run(
    `INSERT INTO sessions
     (id, created_at, updated_at, title, model, working_dir, status,
      claude_started, slack_team_id, slack_channel_id, slack_thread_ts,
      permission_mode, persona_id)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, ?, ?)`,
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
    ],
  );
  return findById(id)!;
}

export function findById(id: string): SessionRow | null {
  return (
    (db.query(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow) ??
    null
  );
}

export function markStarted(id: string) {
  db.run(`UPDATE sessions SET claude_started = 1, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

export function setStatus(id: string, status: string) {
  db.run(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    Date.now(),
    id,
  ]);
}

export function clearStarted(id: string) {
  db.run(`UPDATE sessions SET claude_started = 0, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

/** Persist per-thread engagement so a disengage (user @mentioned a colleague)
 *  survives both the next-message restore path and gateway restarts. */
export function setEngaged(id: string, engaged: boolean) {
  db.run(`UPDATE sessions SET engaged = ?, updated_at = ? WHERE id = ?`, [
    engaged ? 1 : 0,
    Date.now(),
    id,
  ]);
}

export function setPermissionMode(id: string, mode: string) {
  db.run(`UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?`, [
    mode,
    Date.now(),
    id,
  ]);
}

export function setModel(id: string, model: string) {
  db.run(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`, [
    model,
    Date.now(),
    id,
  ]);
}
