import { randomUUID } from "node:crypto";
import { db } from "./schema";

export type ProposalKind = "team-fact" | "promote" | "skill-removal" | "lesson-promotion";
export const PROPOSAL_KINDS: readonly ProposalKind[] = ["team-fact", "promote", "skill-removal", "lesson-promotion"];
export type ProposalTo = "manager" | "person";
export type ProposalStatus = "open" | "approved" | "rejected" | "expired";

/** Unanswered proposals expire after this long (global constraints: 14 days). */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface Proposal {
  id: string;
  agentId: string;
  kind: ProposalKind;
  toKind: ProposalTo;
  /** The person's Slack user id when toKind is "person"; null for the manager. */
  toUser: string | null;
  /** 'agent' or 'user:<id>': the scope of the pass that proposed it. */
  scope: string;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: number | null;
}

interface Row {
  id: string;
  agent_id: string;
  kind: ProposalKind;
  to_kind: ProposalTo;
  to_user: string | null;
  scope: string;
  payload: unknown;
  created_at: number | string;
  expires_at: number | string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: number | string | null;
}

/** sqlite stores payload as JSON text; Postgres as JSONB (which may come back as a JSON string scalar). */
function parsePayload(v: unknown): Record<string, unknown> {
  const parsed = typeof v === "string" ? JSON.parse(v) : v;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function toProposal(r: Row): Proposal {
  return {
    id: r.id,
    agentId: r.agent_id,
    kind: r.kind,
    toKind: r.to_kind,
    toUser: r.to_user,
    scope: r.scope,
    payload: parsePayload(r.payload),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
  };
}

/** Queue an open proposal; it expires PROPOSAL_TTL_MS after `createdAt`. */
export async function insert(p: {
  agentId: string;
  kind: ProposalKind;
  toKind: ProposalTo;
  toUser: string | null;
  scope: string;
  payload: Record<string, unknown>;
  createdAt: number;
}): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO proposals (id, agent_id, kind, to_kind, to_user, scope, payload, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    [id, p.agentId, p.kind, p.toKind, p.toUser, p.scope, JSON.stringify(p.payload), p.createdAt, p.createdAt + PROPOSAL_TTL_MS],
  );
  return id;
}

export async function get(id: string): Promise<Proposal | null> {
  const row = await db.one<Row>("SELECT * FROM proposals WHERE id = ?", [id]);
  return row ? toProposal(row) : null;
}

/** An agent's open proposals for one audience (and, for "person", one user), oldest first. */
export async function listOpen(agentId: string, toKind: ProposalTo, toUser?: string): Promise<Proposal[]> {
  const rows = await db.query<Row>(
    `SELECT * FROM proposals
      WHERE agent_id = ? AND status = 'open' AND to_kind = ?${toUser !== undefined ? " AND to_user = ?" : ""}
      ORDER BY created_at ASC`,
    toUser !== undefined ? [agentId, toKind, toUser] : [agentId, toKind],
  );
  return rows.map(toProposal);
}

/** Settle an open, unexpired proposal. False when it was not open or is past expires_at (even before expireDue swept it). */
export async function decide(id: string, status: "approved" | "rejected", by: string, at: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?",
    [status, by, at, id, at],
  );
  return r.changes > 0;
}

/** Mark every open proposal past its expires_at as expired; returns how many. */
export async function expireDue(now: number): Promise<number> {
  const r = await db.run("UPDATE proposals SET status = 'expired' WHERE status = 'open' AND expires_at <= ?", [now]);
  return r.changes;
}
