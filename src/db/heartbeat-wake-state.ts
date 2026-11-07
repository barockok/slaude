import { db } from "./schema";

/**
 * Per agent, when it next needs to look and how its last wake went (migration
 * 0031). Times are epoch ms. Database only: the decisions are in
 * src/proactive/wake-gate.ts.
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

type Row = {
  agent_id: string;
  next_check_at: number | string | null;
  last_wake_at: number | string | null;
  finished_at: number | string | null;
  last_outcome: string | null;
  failures: number | string;
  checklist_hash: string | null;
};

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

export async function get(agentId: string): Promise<WakeState | null> {
  const r = await db.one<Row>(`SELECT * FROM heartbeat_wake_state WHERE agent_id = ?`, [agentId]);
  if (!r) return null;
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

/** A wake is starting: remember when, and which checklist it saw. */
export async function noteStart(agentId: string, checklistHash: string, now: number): Promise<void> {
  await db.run(
    `INSERT INTO heartbeat_wake_state (agent_id, last_wake_at, checklist_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET
       last_wake_at = excluded.last_wake_at,
       checklist_hash = excluded.checklist_hash,
       updated_at = excluded.updated_at`,
    [agentId, now, checklistHash, now],
  );
}

/** The agent called finish_round. `nextCheckAt` is already clamped. */
export async function noteFinished(agentId: string, nextCheckAt: number, now: number): Promise<void> {
  await db.run(
    `INSERT INTO heartbeat_wake_state (agent_id, next_check_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET
       next_check_at = excluded.next_check_at,
       finished_at = excluded.finished_at,
       updated_at = excluded.updated_at`,
    [agentId, nextCheckAt, now, now],
  );
}

/** The wake's run ended: its outcome, the failure count, and possibly a new next check. */
export async function noteSettled(agentId: string, s: { outcome: string; failures: number; nextCheckAt: number | null }, now: number): Promise<void> {
  await db.run(
    `INSERT INTO heartbeat_wake_state (agent_id, last_outcome, failures, next_check_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET
       last_outcome = excluded.last_outcome,
       failures = excluded.failures,
       next_check_at = COALESCE(excluded.next_check_at, heartbeat_wake_state.next_check_at),
       updated_at = excluded.updated_at`,
    [agentId, s.outcome, s.failures, s.nextCheckAt, now],
  );
}

/** A manager asked for a look now: the next gate check finds it due. */
export async function markDue(agentId: string, now: number): Promise<void> {
  await db.run(`UPDATE heartbeat_wake_state SET next_check_at = ?, updated_at = ? WHERE agent_id = ?`, [now, now, agentId]);
}
