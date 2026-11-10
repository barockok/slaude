import { db } from "./schema";
import { toWakeState, type WakeRow, type WakeState } from "./heartbeat-wake-state";

/**
 * Per agent and channel, when it next needs to look and how its last wake went
 * (migration 0037), for channel session mode. Times are epoch ms. Database
 * only: the decisions are in src/proactive/wake-gate.ts.
 */
export type ChannelWakeState = WakeState & { channelId: string };

type Row = WakeRow & { channel_id: string };

export async function get(agentId: string, channelId: string): Promise<ChannelWakeState | null> {
  const r = await db.one<Row>(`SELECT * FROM channel_wake_state WHERE agent_id = ? AND channel_id = ?`, [agentId, channelId]);
  return r ? { ...toWakeState(r), channelId: r.channel_id } : null;
}

/** A wake is starting: remember when, which checklist it saw, and its ledger run. */
export async function noteStart(agentId: string, channelId: string, checklistHash: string, runId: string, now: number): Promise<void> {
  await db.run(
    `INSERT INTO channel_wake_state (agent_id, channel_id, last_wake_at, checklist_hash, open_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET
       last_wake_at = excluded.last_wake_at,
       checklist_hash = excluded.checklist_hash,
       open_run_id = excluded.open_run_id,
       updated_at = excluded.updated_at`,
    [agentId, channelId, now, checklistHash, runId, now],
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

/** A manager asked for a look now: the next gate check finds it due. */
export async function markDue(agentId: string, channelId: string, now: number): Promise<void> {
  await db.run(`UPDATE channel_wake_state SET next_check_at = ?, updated_at = ? WHERE agent_id = ? AND channel_id = ?`, [now, now, agentId, channelId]);
}

/** The channel whose wake is still open on this ledger run, or null once settled or replaced. */
export async function channelOfRun(runId: string): Promise<string | null> {
  const r = await db.one<{ channel_id: string }>(`SELECT channel_id FROM channel_wake_state WHERE open_run_id = ?`, [runId]);
  return r?.channel_id ?? null;
}
