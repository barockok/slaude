/**
 * Durable gate state (permission prompts, plan approvals, /mcp connect
 * buttons). The DB row is the source of truth for whether a gate is still
 * open; the single guarded UPDATE in `resolve` makes a Block Kit click
 * idempotent and cross-replica safe — exactly one resolver wins, every later
 * click sees null and treats it as stale.
 *
 * In-process Promise maps remain the wakeup mechanism until the long-poll /
 * pub-sub plane lands (spec §5, M4).
 */
import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type GateKind = "perm" | "approval" | "mcp_connect";
export type GateStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

/**
 * This process's boot-time identity, stamped on every row it mints. A gate
 * whose promise waiter lives in-process can only be woken by this process; a
 * replica must therefore never click-cancel a pending row minted by a DIFFERENT
 * instance (the sibling may be alive and waiting) — foreign rows drain via
 * expires_at, and clicks on them are answered "pending on another replica"
 * until the long-poll plane (M4) makes cross-replica resolution live.
 */
export const INSTANCE_ID = randomUUID();

export type PendingGate = {
  id: string;
  sessionId: string;
  kind: GateKind;
  payload: Record<string, unknown>;
  status: GateStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  /** Boot-time id of the process that minted the row; null on pre-upgrade rows. */
  instanceId: string | null;
};

export async function create(args: {
  /** Caller-chosen id (toolUseID, connect token). Defaults to a fresh UUID. */
  id?: string;
  kind: GateKind;
  sessionId: string;
  payload?: Record<string, unknown>;
  expiresAt?: number;
}): Promise<PendingGate> {
  const id = args.id ?? randomUUID();
  await db.run(
    `INSERT INTO pending_gates (id, session_id, kind, payload, status, expires_at, created_at, instance_id)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, args.sessionId, args.kind, JSON.stringify(args.payload ?? {}), args.expiresAt ?? null, Date.now(), INSTANCE_ID],
  );
  return (await get(id))!;
}

export async function get(id: string): Promise<PendingGate | null> {
  const row = await db.one<any>(`SELECT * FROM pending_gates WHERE id = ?`, [id]);
  return row ? mapRow(row) : null;
}

/**
 * Resolve a gate iff it is still pending. Returns the resolved row, or null
 * when someone else already settled it (duplicate click, expiry, abort) — the
 * caller must treat null as a stale click and change nothing.
 */
export async function resolve(
  id: string,
  status: Exclude<GateStatus, "pending">,
  resolvedBy: string,
): Promise<PendingGate | null> {
  const rows = await db.query<any>(
    `UPDATE pending_gates
     SET status = ?, resolved_by = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending'
     RETURNING *`,
    [status, resolvedBy, Date.now(), id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Expire every pending gate whose deadline passed. Returns the expired rows
 *  (boot sweep logs them; the recurring sweep ignores the result). */
export async function sweepExpired(now: number = Date.now()): Promise<PendingGate[]> {
  const rows = await db.query<any>(
    `UPDATE pending_gates
     SET status = 'expired', resolved_by = 'system', resolved_at = ?
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
     RETURNING *`,
    [now, now],
  );
  return rows.map(mapRow);
}

/** Delete settled rows past their audit horizon so the table stays bounded.
 *  Pending rows are never touched — they settle via resolve/sweepExpired. */
export async function purgeSettledOlderThan(
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  const r = await db.run(
    `DELETE FROM pending_gates
     WHERE status != 'pending' AND COALESCE(resolved_at, created_at) < ?`,
    [now - maxAgeMs],
  );
  return r.changes;
}

function mapRow(row: any): PendingGate {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    status: row.status,
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    instanceId: row.instance_id ?? null,
  };
}

function parsePayload(v: unknown): Record<string, unknown> {
  // sqlite stores TEXT; the Postgres drivers hand JSONB back already parsed.
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return (v as Record<string, unknown>) ?? {};
}
