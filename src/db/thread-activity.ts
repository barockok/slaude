import type { BrainScope } from "../knowledge/scope";
import { agentSourceId, userSourceId } from "../knowledge/scope";
import { db } from "./schema";

/**
 * Per-thread turn activity for the quiet-moment pass (spec §9.1; migration
 * 0023). Bumped at turn end by the memory sync paths, read by the background
 * scheduler. Database only: nothing here calls the brain.
 */
export interface ThreadActivity {
  sessionId: string;
  agentId: string;
  turns: number;
  lastTurnAt: number;
  summarizedAt: number | null;
  /** 'agent' or 'user:<id>': whose memory the thread's conversation page is kept in. */
  scope: string;
}

interface Row {
  session_id: string;
  agent_id: string;
  turns: number | string;
  last_turn_at: number | string;
  summarized_at: number | string | null;
  scope: string;
}

const toActivity = (r: Row): ThreadActivity => ({
  sessionId: r.session_id,
  agentId: r.agent_id,
  turns: Number(r.turns),
  lastTurnAt: Number(r.last_turn_at),
  summarizedAt: r.summarized_at === null ? null : Number(r.summarized_at),
  scope: r.scope,
});

/**
 * The activity scope of a memory write: 'agent' when the turn's page went to
 * the agent's own slice, 'user:<id>' when it went to that person's slice, null
 * for anything else (no page, or a source no pass reviews).
 */
export function activityScopeOf(write: BrainScope | null, agentId: string): string | null {
  if (!write) return null;
  if (write.sourceId === agentSourceId(agentId)) return "agent";
  if (write.clientId && write.sourceId.startsWith("user-") && userSourceId(write.clientId) === write.sourceId) return `user:${write.clientId}`;
  return null;
}

/**
 * Count one turn of a thread. A turn in a different scope or for a different
 * agent than the row's restarts the count (its page lives in another slice)
 * and clears summarized_at; last_turn_at never moves backwards.
 */
export async function recordTurn(a: { sessionId: string; agentId: string; scope: string; at?: number }): Promise<void> {
  const at = a.at ?? Date.now();
  await db.run(
    `INSERT INTO thread_activity (session_id, agent_id, turns, last_turn_at, summarized_at, scope)
     VALUES (?, ?, 1, ?, NULL, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       turns = CASE WHEN thread_activity.scope = excluded.scope AND thread_activity.agent_id = excluded.agent_id
                    THEN thread_activity.turns + 1 ELSE 1 END,
       summarized_at = CASE WHEN thread_activity.scope = excluded.scope AND thread_activity.agent_id = excluded.agent_id
                            THEN thread_activity.summarized_at ELSE NULL END,
       last_turn_at = CASE WHEN excluded.last_turn_at > thread_activity.last_turn_at
                           THEN excluded.last_turn_at ELSE thread_activity.last_turn_at END,
       agent_id = excluded.agent_id,
       scope = excluded.scope`,
    [a.sessionId, a.agentId, at, a.scope],
  );
}

/**
 * Best effort recordTurn for the turn-end paths: a failure is logged, never
 * thrown, so it cannot fail a turn's memory sync. Does nothing for a write
 * no pass reviews (activityScopeOf null).
 */
export async function noteThreadTurn(sessionId: string, agentId: string, write: BrainScope | null): Promise<void> {
  const scope = activityScopeOf(write, agentId);
  if (!scope) return;
  try {
    await recordTurn({ sessionId, agentId, scope });
  } catch (e) {
    console.error(`[background] could not record thread activity for session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function get(sessionId: string): Promise<ThreadActivity | null> {
  const row = await db.one<Row>("SELECT * FROM thread_activity WHERE session_id = ?", [sessionId]);
  return row ? toActivity(row) : null;
}

/**
 * An agent's threads due a quiet-moment pass, quiet longest first: at least
 * `minTurns` turns, no turn after `quietBefore` (ms), not summarized through
 * their last turn, and whose slot `<session>@<last_turn_at>` (the
 * quiet-moment claim) was not claimed yet.
 */
export async function due(agentId: string, o: { minTurns: number; quietBefore: number; limit: number }): Promise<ThreadActivity[]> {
  if (o.limit <= 0) return [];
  const rows = await db.query<Row>(
    `SELECT ta.* FROM thread_activity ta
      WHERE ta.agent_id = ? AND ta.turns >= ? AND ta.last_turn_at <= ?
        AND (ta.summarized_at IS NULL OR ta.summarized_at < ta.last_turn_at)
        AND NOT EXISTS (
          SELECT 1 FROM background_slots s
           WHERE s.agent_id = ta.agent_id AND s.pass = 'quiet-moment'
             AND s.slot = ta.session_id || '@' || CAST(ta.last_turn_at AS TEXT))
      ORDER BY ta.last_turn_at ASC
      LIMIT ?`,
    [agentId, o.minTurns, o.quietBefore, o.limit],
  );
  return rows.map(toActivity);
}

/** Record that a summary covers the thread through `through` (a last_turn_at); never moves backwards. */
export async function markSummarized(sessionId: string, through: number): Promise<void> {
  await db.run(
    `UPDATE thread_activity SET summarized_at = ?
      WHERE session_id = ? AND (summarized_at IS NULL OR summarized_at < ?)`,
    [through, sessionId, through],
  );
}
