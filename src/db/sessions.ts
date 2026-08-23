import { db, type SessionRow } from "./schema";
import { randomUUID } from "node:crypto";

export type ThreadKey = {
  team_id: string;
  channel_id: string;
  thread_ts: string;
  /** Which persona owns this session. Defaults to 'default' (the single-bot mode). */
  persona_id?: string;
};

export async function findByThread(k: ThreadKey): Promise<SessionRow | null> {
  const personaId = k.persona_id ?? "default";
  return db.one<SessionRow>(
    `SELECT * FROM sessions
     WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       AND persona_id = ?`,
    [k.team_id, k.channel_id, k.thread_ts, personaId],
  );
}

/** Find the most-recently-updated session for a thread regardless of persona.
 *  Used for "is there any session to populate?" checks (engagement restore,
 *  mention-only recording) where the caller doesn't know which persona to ask for. */
export async function findAnyByThread(k: Omit<ThreadKey, "persona_id">): Promise<SessionRow | null> {
  return db.one<SessionRow>(
    `SELECT * FROM sessions
     WHERE slack_team_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [k.team_id, k.channel_id, k.thread_ts],
  );
}

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
  await db.run(
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
  return (await findById(id))!;
}

export async function findById(id: string): Promise<SessionRow | null> {
  return db.one<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [id]);
}

export async function markStarted(id: string): Promise<void> {
  await db.run(`UPDATE sessions SET claude_started = 1, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

export async function setStatus(id: string, status: string): Promise<void> {
  await db.run(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    Date.now(),
    id,
  ]);
}

export async function clearStarted(id: string): Promise<void> {
  await db.run(`UPDATE sessions SET claude_started = 0, updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
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
