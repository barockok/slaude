import { db } from "./schema";

/**
 * Open commitments indexed for the promise scheduler (spec §10.1; migration
 * 0028). The brain page is the truth; a row mirrors one page with its next
 * check time. Database only.
 */
export type CommitmentStatus = "open" | "done" | "dropped" | "expired";

export interface CommitmentRow {
  agentId: string;
  source: string;
  slug: string;
  personaId: string;
  teamId: string | null;
  channelId: string;
  threadTs: string;
  beneficiary: string;
  runAs: string | null;
  dueText: string;
  dueKind: "time" | "event";
  checkText: string;
  onNoChange: "silent" | "close-in-one-line";
  nextCheckAt: number;
  expiresAt: number;
  status: CommitmentStatus;
  checks: number;
  lastCheckedAt: number | null;
  createdAt: number;
}

export type CommitmentKey = Pick<CommitmentRow, "agentId" | "source" | "slug">;

interface Row {
  agent_id: string;
  source: string;
  slug: string;
  persona_id: string;
  team_id: string | null;
  channel_id: string;
  thread_ts: string;
  beneficiary: string;
  run_as: string | null;
  due_text: string;
  due_kind: string;
  check_text: string;
  on_no_change: string;
  next_check_at: number | string;
  expires_at: number | string;
  status: string;
  checks: number | string;
  last_checked_at: number | string | null;
  created_at: number | string;
}

const toRow = (r: Row): CommitmentRow => ({
  agentId: r.agent_id,
  source: r.source,
  slug: r.slug,
  personaId: r.persona_id,
  teamId: r.team_id,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  beneficiary: r.beneficiary,
  runAs: r.run_as,
  dueText: r.due_text,
  dueKind: r.due_kind === "time" ? "time" : "event",
  checkText: r.check_text,
  onNoChange: r.on_no_change === "close-in-one-line" ? "close-in-one-line" : "silent",
  nextCheckAt: Number(r.next_check_at),
  expiresAt: Number(r.expires_at),
  status: r.status as CommitmentStatus,
  checks: Number(r.checks),
  lastCheckedAt: r.last_checked_at === null ? null : Number(r.last_checked_at),
  createdAt: Number(r.created_at),
});

/** Insert or refresh an open commitment; a rewrite of the page reschedules it and reopens a closed row. */
export async function upsertOpen(c: Omit<CommitmentRow, "status" | "checks" | "lastCheckedAt">): Promise<void> {
  await db.run(
    `INSERT INTO commitments (agent_id, source, slug, persona_id, team_id, channel_id, thread_ts, beneficiary, run_as,
                              due_text, due_kind, check_text, on_no_change, next_check_at, expires_at, status, checks, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)
     ON CONFLICT (agent_id, source, slug) DO UPDATE SET
       persona_id = excluded.persona_id,
       team_id = COALESCE(excluded.team_id, commitments.team_id),
       channel_id = excluded.channel_id,
       thread_ts = excluded.thread_ts,
       beneficiary = excluded.beneficiary,
       run_as = excluded.run_as,
       due_text = excluded.due_text,
       due_kind = excluded.due_kind,
       check_text = excluded.check_text,
       on_no_change = excluded.on_no_change,
       next_check_at = excluded.next_check_at,
       expires_at = excluded.expires_at,
       status = 'open'`,
    [
      c.agentId, c.source, c.slug, c.personaId, c.teamId, c.channelId, c.threadTs, c.beneficiary, c.runAs,
      c.dueText, c.dueKind, c.checkText, c.onNoChange, c.nextCheckAt, c.expiresAt, c.createdAt,
    ],
  );
}

/**
 * Close a row. True when a row changed. `expired` closes only an open row;
 * `done`/`dropped` (what the page says) also settle an expired one, whose
 * last check may resolve it after the scheduler stopped checking.
 */
export async function close(k: CommitmentKey, status: Exclude<CommitmentStatus, "open">): Promise<boolean> {
  const from = status === "expired" ? "('open')" : "('open', 'expired')";
  const r = await db.run(`UPDATE commitments SET status = ? WHERE agent_id = ? AND source = ? AND slug = ? AND status IN ${from}`, [
    status, k.agentId, k.source, k.slug,
  ]);
  return (r.changes ?? 0) > 0;
}

export async function get(k: CommitmentKey): Promise<CommitmentRow | null> {
  const row = await db.one<Row>(`SELECT * FROM commitments WHERE agent_id = ? AND source = ? AND slug = ?`, [k.agentId, k.source, k.slug]);
  return row ? toRow(row) : null;
}

/** An agent's open commitments whose next check is due, earliest first. */
export async function due(agentId: string, now: number, limit = 20): Promise<CommitmentRow[]> {
  if (limit <= 0) return [];
  const rows = await db.query<Row>(
    `SELECT * FROM commitments WHERE agent_id = ? AND status = 'open' AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT ?`,
    [agentId, now, limit],
  );
  return rows.map(toRow);
}

/** Move an open row's next check. */
export async function reschedule(k: CommitmentKey, nextCheckAt: number): Promise<void> {
  await db.run(`UPDATE commitments SET next_check_at = ? WHERE agent_id = ? AND source = ? AND slug = ? AND status = 'open'`, [
    nextCheckAt, k.agentId, k.source, k.slug,
  ]);
}

/** Count one check that ran (a turn was dispatched) and set the next one. */
export async function markChecked(k: CommitmentKey, at: number, nextCheckAt: number): Promise<void> {
  await db.run(
    `UPDATE commitments SET checks = checks + 1, last_checked_at = ?, next_check_at = ?
      WHERE agent_id = ? AND source = ? AND slug = ? AND status = 'open'`,
    [at, nextCheckAt, k.agentId, k.source, k.slug],
  );
}
