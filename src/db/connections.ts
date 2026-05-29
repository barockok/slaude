import { randomUUID } from "node:crypto";
import { db, type ConnectionRow, type ConnectionGrantRow } from "./schema";

export type ThreadKey = { team_id: string; channel_id: string; thread_ts: string };

export function insertConnection(args: {
  owner_slack_user_id: string;
  service: string;
  scope: "thread" | "slaude";
  thread?: ThreadKey;
  auth_strategy: "token" | "cookie";
  cred_ciphertext: string;
  key_id: string;
  now: number;
  expires_at?: number | null;
}): ConnectionRow {
  const id = randomUUID();
  db.run(
    `INSERT INTO connections
       (id, owner_slack_user_id, service, scope, team_id, channel_id, thread_ts,
        auth_strategy, cred_ciphertext, key_id, created_at, last_used_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active')`,
    [
      id, args.owner_slack_user_id, args.service, args.scope,
      args.thread?.team_id ?? null, args.thread?.channel_id ?? null, args.thread?.thread_ts ?? null,
      args.auth_strategy, args.cred_ciphertext, args.key_id, args.now, args.expires_at ?? null,
    ],
  );
  return findById(id)!;
}

export function findById(id: string): ConnectionRow | null {
  return (db.query(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow) ?? null;
}

export function findOwnConnection(owner: string, service: string, t: ThreadKey): ConnectionRow | null {
  return (
    (db
      .query(
        `SELECT * FROM connections
         WHERE owner_slack_user_id = ? AND service = ? AND scope = 'thread'
           AND team_id = ? AND channel_id = ? AND thread_ts = ? AND status = 'active'`,
      )
      .get(owner, service, t.team_id, t.channel_id, t.thread_ts) as ConnectionRow) ?? null
  );
}

export function findBorrowCandidate(caller: string, service: string, t: ThreadKey): ConnectionRow | null {
  return (
    (db
      .query(
        `SELECT * FROM connections
         WHERE service = ? AND scope = 'thread'
           AND team_id = ? AND channel_id = ? AND thread_ts = ?
           AND owner_slack_user_id != ? AND status = 'active'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(service, t.team_id, t.channel_id, t.thread_ts, caller) as ConnectionRow) ?? null
  );
}

export function findSlaudeConnection(service: string): ConnectionRow | null {
  return (
    (db
      .query(`SELECT * FROM connections WHERE service = ? AND scope = 'slaude' AND status = 'active' LIMIT 1`)
      .get(service) as ConnectionRow) ?? null
  );
}

export function listForThread(t: ThreadKey): ConnectionRow[] {
  return db
    .query(
      `SELECT * FROM connections WHERE scope = 'thread' AND team_id = ? AND channel_id = ? AND thread_ts = ? AND status = 'active'`,
    )
    .all(t.team_id, t.channel_id, t.thread_ts) as ConnectionRow[];
}

export function touchLastUsed(id: string, now: number) {
  db.run(`UPDATE connections SET last_used_at = ? WHERE id = ?`, [now, id]);
}

export function setStatus(id: string, status: "active" | "expired" | "revoked") {
  db.run(`UPDATE connections SET status = ? WHERE id = ?`, [status, id]);
}

export function listExpired(now: number): ConnectionRow[] {
  return db
    .query(`SELECT * FROM connections WHERE expires_at IS NOT NULL AND expires_at <= ? AND status = 'active'`)
    .all(now) as ConnectionRow[];
}

// --- grants ---
export function insertGrant(args: { connection_id: string; borrower_slack_user_id: string; thread: ThreadKey; now: number }): ConnectionGrantRow {
  const id = randomUUID();
  db.run(
    `INSERT OR REPLACE INTO connection_grants
       (id, connection_id, borrower_slack_user_id, team_id, channel_id, thread_ts, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, args.connection_id, args.borrower_slack_user_id, args.thread.team_id, args.thread.channel_id, args.thread.thread_ts, args.now],
  );
  return db.query(`SELECT * FROM connection_grants WHERE id = ?`).get(id) as ConnectionGrantRow;
}

export function findActiveGrant(connectionId: string, borrower: string): ConnectionGrantRow | null {
  return (
    (db
      .query(`SELECT * FROM connection_grants WHERE connection_id = ? AND borrower_slack_user_id = ? AND revoked_at IS NULL`)
      .get(connectionId, borrower) as ConnectionGrantRow) ?? null
  );
}

export function revokeGrantsForConnection(connectionId: string, now: number) {
  db.run(`UPDATE connection_grants SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL`, [now, connectionId]);
}

// --- audit ---
export function appendAudit(args: {
  connection_id: string; borrower_slack_user_id: string; approver_id?: string | null;
  service?: string; tool?: string; args_hash?: string; decision: string; now: number;
}) {
  db.run(
    `INSERT INTO connection_audit (id, connection_id, borrower_slack_user_id, approver_id, service, tool, args_hash, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), args.connection_id, args.borrower_slack_user_id, args.approver_id ?? null, args.service ?? null, args.tool ?? null, args.args_hash ?? null, args.decision, args.now],
  );
}

export function auditForConnection(connectionId: string) {
  return db.query(`SELECT * FROM connection_audit WHERE connection_id = ? ORDER BY created_at ASC`).all(connectionId);
}

/** Test-only: clear all connection state. */
export function _wipeForTests() {
  db.run(`DELETE FROM connection_audit`);
  db.run(`DELETE FROM connection_grants`);
  db.run(`DELETE FROM connections`);
}
