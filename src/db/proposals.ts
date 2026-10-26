import { randomUUID } from "node:crypto";
import { db } from "./schema";

export type ProposalKind = "team-fact" | "promote" | "skill-removal" | "lesson-promotion";
export const PROPOSAL_KINDS: readonly ProposalKind[] = ["team-fact", "promote", "skill-removal", "lesson-promotion"];
export type ProposalTo = "manager" | "person";
/**
 * A skill the weekly skill review retired (Task 8 ruling C): not a proposal
 * but a settled event in the same table, so the weekly digest reads it beside
 * the proposals. Stored with status `approved`, to_kind `manager`, decided_by
 * SKILL_REVIEW_ACTOR; never open, so never carded or expired.
 */
export const SKILL_RETIRED_KIND = "skill-retired" as const;
export const SKILL_REVIEW_ACTOR = "skill-review";
export type ProposalRowKind = ProposalKind | typeof SKILL_RETIRED_KIND;
export type ProposalStatus = "open" | "approved" | "rejected" | "expired";

/** Unanswered proposals expire after this long (global constraints: 14 days). */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface Proposal {
  id: string;
  agentId: string;
  kind: ProposalRowKind;
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
  /** The Slack app (and workspace) its card was posted as; null until posted. */
  slackAppId: string | null;
  slackTeamId: string | null;
}

interface Row {
  id: string;
  agent_id: string;
  kind: ProposalRowKind;
  to_kind: ProposalTo;
  to_user: string | null;
  scope: string;
  payload: unknown;
  created_at: number | string;
  expires_at: number | string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: number | string | null;
  slack_app_id?: string | null;
  slack_team_id?: string | null;
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
    slackAppId: r.slack_app_id ?? null,
    slackTeamId: r.slack_team_id ?? null,
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
  /** The card's Slack app, when already known (a forwarded promotion keeps its own). */
  slackAppId?: string | null;
  slackTeamId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO proposals (id, agent_id, kind, to_kind, to_user, scope, payload, created_at, expires_at, status, slack_app_id, slack_team_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [id, p.agentId, p.kind, p.toKind, p.toUser, p.scope, JSON.stringify(p.payload), p.createdAt, p.createdAt + PROPOSAL_TTL_MS, p.slackAppId ?? null, p.slackTeamId ?? null],
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

/** Payload of a SKILL_RETIRED_KIND event. */
export interface SkillRetiredPayload {
  slug: string;
  /** The retired copy's id (skillOps.restore takes it). */
  retiredId: string;
  /** The persona whose skills root it was retired from. */
  persona: string;
  reason: string;
  uses: number;
  lastUsedAt: number | null;
}

/** Record that the skill review retired a skill (an already-settled row). */
export async function recordSkillRetired(a: { agentId: string; payload: SkillRetiredPayload; at: number }): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO proposals (id, agent_id, kind, to_kind, to_user, scope, payload, created_at, expires_at, status, decided_by, decided_at)
     VALUES (?, ?, ?, 'manager', NULL, 'agent', ?, ?, ?, 'approved', ?, ?)`,
    [id, a.agentId, SKILL_RETIRED_KIND, JSON.stringify(a.payload), a.at, a.at, SKILL_REVIEW_ACTOR, a.at],
  );
  return id;
}

/** An agent's skill retirements at or after `since` (epoch ms), oldest first. */
export async function listSkillRetirements(agentId: string, since: number): Promise<Proposal[]> {
  const rows = await db.query<Row>(
    "SELECT * FROM proposals WHERE agent_id = ? AND kind = ? AND created_at >= ? ORDER BY created_at ASC",
    [agentId, SKILL_RETIRED_KIND, since],
  );
  return rows.map(toProposal);
}

/** Mark every open proposal past its expires_at as expired; returns how many. */
export async function expireDue(now: number): Promise<number> {
  const r = await db.run("UPDATE proposals SET status = 'expired' WHERE status = 'open' AND expires_at <= ?", [now]);
  return r.changes;
}

/**
 * Undo an approval whose write failed, so the proposal can be tried again:
 * only the exact decision `decide` recorded (same approver and time) goes
 * back to open, and only while it is unexpired.
 */
export async function reopen(id: string, by: string, at: number): Promise<boolean> {
  const r = await db.run(
    `UPDATE proposals SET status = 'open', decided_by = NULL, decided_at = NULL
      WHERE id = ? AND status = 'approved' AND decided_by = ? AND decided_at = ? AND expires_at > ?`,
    [id, by, at, at],
  );
  return r.changes > 0;
}

/**
 * Claim the restore of a retired skill: the retirement row goes from
 * `approved` to `rejected` (the retirement was undone), decided by `by`. One
 * caller wins across replicas; false when it was already restored (or is not
 * a retirement).
 */
export async function claimSkillRestore(id: string, by: string, at: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND kind = ? AND status = 'approved'",
    [by, at, id, SKILL_RETIRED_KIND],
  );
  return r.changes > 0;
}

/** Give back a restore claim whose move failed: the skill is still retired. */
export async function releaseSkillRestore(id: string, by: string, at: number): Promise<void> {
  await db.run(
    `UPDATE proposals SET status = 'approved', decided_by = ?, decided_at = created_at
      WHERE id = ? AND kind = ? AND status = 'rejected' AND decided_by = ? AND decided_at = ?`,
    [SKILL_REVIEW_ACTOR, id, SKILL_RETIRED_KIND, by, at],
  );
}

/**
 * Record the Slack app a card was posted as, on rows that have none yet: the
 * first post binds the card, so a later click must come through that app.
 */
export async function stampApp(ids: readonly string[], app: { apiAppId?: string; teamId?: string }): Promise<void> {
  if (ids.length === 0 || (!app.apiAppId && !app.teamId)) return;
  const marks = ids.map(() => "?").join(", ");
  await db.run(
    `UPDATE proposals SET slack_app_id = ?, slack_team_id = ? WHERE id IN (${marks}) AND slack_app_id IS NULL AND slack_team_id IS NULL`,
    [app.apiAppId ?? null, app.teamId ?? null, ...ids],
  );
}
