import { db } from "./schema";

/**
 * Per agent and channel, when it next needs to look and how its last wake went
 * (migration 0037), for channel session mode. Times are epoch ms. Database
 * only: the decisions are in src/proactive/wake-gate.ts.
 */
export interface WakeState {
  agentId: string;
  nextCheckAt: number | null;
  lastWakeAt: number | null;
  /** When the agent last called finish_round. */
  finishedAt: number | null;
  lastOutcome: string | null;
  failures: number;
  checklistHash: string | null;
}

export type WakeRow = {
  agent_id: string;
  next_check_at: number | string | null;
  last_wake_at: number | string | null;
  finished_at: number | string | null;
  last_outcome: string | null;
  failures: number | string;
  checklist_hash: string | null;
};

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toWakeState(r: WakeRow): WakeState {
  return {
    agentId: r.agent_id,
    nextCheckAt: num(r.next_check_at),
    lastWakeAt: num(r.last_wake_at),
    finishedAt: num(r.finished_at),
    lastOutcome: r.last_outcome,
    failures: Number(r.failures),
    checklistHash: r.checklist_hash,
  };
}

export type ChannelWakeState = WakeState & { channelId: string };

type Row = WakeRow & { channel_id: string };

export async function get(agentId: string, channelId: string): Promise<ChannelWakeState | null> {
  const r = await db.one<Row>(`SELECT * FROM channel_wake_state WHERE agent_id = ? AND channel_id = ?`, [agentId, channelId]);
  return r ? { ...toWakeState(r), channelId: r.channel_id } : null;
}

/**
 * A wake is starting: remember when, which checklist it saw, and its ledger run.
 * False when a run still open holds this channel: two starts can both pass the
 * open-run check, and only one may own the row. A run that has ended, or is
 * unknown, can be replaced.
 */
export async function noteStart(agentId: string, channelId: string, checklistHash: string, runId: string, now: number): Promise<boolean> {
  const res = await db.run(
    `INSERT INTO channel_wake_state (agent_id, channel_id, last_wake_at, checklist_hash, open_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET
       last_wake_at = excluded.last_wake_at,
       checklist_hash = excluded.checklist_hash,
       open_run_id = excluded.open_run_id,
       updated_at = excluded.updated_at
     WHERE channel_wake_state.open_run_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM background_runs r WHERE r.id = channel_wake_state.open_run_id AND r.outcome IS NULL)`,
    [agentId, channelId, now, checklistHash, runId, now],
  );
  return res.changes > 0;
}

/**
 * A wake started and then never ran (a person's turn began first): the row goes
 * back to what it was. Only while this run still owns it. `previous` null is a
 * channel with no row before: its wake then reads as never having happened.
 */
export async function undoStart(agentId: string, channelId: string, runId: string, previous: Pick<ChannelWakeState, "lastWakeAt" | "checklistHash"> | null, now: number): Promise<void> {
  await db.run(
    `UPDATE channel_wake_state SET last_wake_at = ?, checklist_hash = ?, open_run_id = NULL, updated_at = ?
     WHERE agent_id = ? AND channel_id = ? AND open_run_id = ?`,
    [previous?.lastWakeAt ?? null, previous?.checklistHash ?? null, now, agentId, channelId, runId],
  );
}

/** The agent called finish_round. `nextCheckAt` is already clamped. */
export async function noteFinished(agentId: string, channelId: string, nextCheckAt: number, now: number): Promise<void> {
  await db.run(
    `INSERT INTO channel_wake_state (agent_id, channel_id, next_check_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET
       next_check_at = excluded.next_check_at,
       finished_at = excluded.finished_at,
       updated_at = excluded.updated_at`,
    [agentId, channelId, nextCheckAt, now, now],
  );
}

/** The wake's run ended: its outcome, the failure count, and possibly a new next check. Closes the open run. */
export async function noteSettled(agentId: string, channelId: string, s: { outcome: string; failures: number; nextCheckAt: number | null }, now: number): Promise<void> {
  await db.run(
    `INSERT INTO channel_wake_state (agent_id, channel_id, last_outcome, failures, next_check_at, open_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET
       last_outcome = excluded.last_outcome,
       failures = excluded.failures,
       next_check_at = COALESCE(excluded.next_check_at, channel_wake_state.next_check_at),
       open_run_id = NULL,
       updated_at = excluded.updated_at`,
    [agentId, channelId, s.outcome, s.failures, s.nextCheckAt, now],
  );
}

/** The channel whose wake is still open on this ledger run, or null once settled or replaced. */
export async function channelOfRun(runId: string): Promise<string | null> {
  const r = await db.one<{ channel_id: string }>(`SELECT channel_id FROM channel_wake_state WHERE open_run_id = ?`, [runId]);
  return r?.channel_id ?? null;
}
