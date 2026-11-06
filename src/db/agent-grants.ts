import { randomUUID } from "node:crypto";
import { db, dbDialect } from "./schema";

/**
 * Stored agent grants (migration 0032): who may use or administer a persona,
 * keyed by persona name. A deny row for a user blocks them even where a channel
 * grant admits. Expiry is filtered at read time; there is no sweep.
 *
 * revoke is a hard delete: the audit row (written by the API layer) is the
 * durable record. This repo does not audit.
 *
 * tenant_id exists on Postgres only (see tests/db/schema-drift.test.ts), so the
 * tenant is written and filtered on Postgres and ignored on sqlite.
 */
export const GRANT_ROLES = ["manager", "approver", "member"] as const;
export const SUBJECT_KINDS = ["user", "channel", "workspace"] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface AgentGrantRow {
  id: string;
  tenantId: string;
  persona: string;
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny: boolean;
  dmOnly: boolean;
  createdBy: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; null = never. */
  expiresAt: number | null;
  note: string | null;
}

export interface CreateGrantInput {
  tenantId?: string;
  persona: string;
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny?: boolean;
  dmOnly?: boolean;
  createdBy: string;
  expiresAt?: number | null;
  note?: string | null;
}

const DEFAULT_TENANT = "default";

export async function create(input: CreateGrantInput, now: number = Date.now()): Promise<AgentGrantRow> {
  if (!GRANT_ROLES.includes(input.role)) throw new Error(`agent grant: invalid role ${JSON.stringify(input.role)}`);
  if (!SUBJECT_KINDS.includes(input.subjectKind)) throw new Error(`agent grant: invalid subject_kind ${JSON.stringify(input.subjectKind)}`);
  if (!input.subjectId) throw new Error("agent grant: subject_id is required");
  if (!input.persona) throw new Error("agent grant: persona is required");
  const row: AgentGrantRow = {
    id: randomUUID(),
    tenantId: input.tenantId ?? DEFAULT_TENANT,
    persona: input.persona,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    role: input.role,
    deny: input.deny ?? false,
    dmOnly: input.dmOnly ?? false,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
    note: input.note ?? null,
  };
  const pg = dbDialect() === "pg";
  const bool = (b: boolean) => (pg ? b : b ? 1 : 0);
  const cols = ["id", "persona", "subject_kind", "subject_id", "role", "deny", "dm_only", "created_by", "created_at", "expires_at", "note"];
  const params: unknown[] = [
    row.id, row.persona, row.subjectKind, row.subjectId, row.role, bool(row.deny), bool(row.dmOnly),
    row.createdBy, row.createdAt, row.expiresAt, row.note,
  ];
  if (pg) {
    cols.push("tenant_id");
    params.push(row.tenantId);
  }
  await db.run(`INSERT INTO agent_grants (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params);
  return row;
}

/** A persona's live grants: expired rows are left out (`expires_at > now`). */
export async function listForPersona(persona: string, now: number = Date.now(), tenant: string = DEFAULT_TENANT): Promise<AgentGrantRow[]> {
  const where = ["persona = ?", "(expires_at IS NULL OR expires_at > ?)"];
  const params: unknown[] = [persona, now];
  if (dbDialect() === "pg") {
    where.push("tenant_id = ?");
    params.push(tenant);
  }
  const rows = await db.query<Row>(`SELECT * FROM agent_grants WHERE ${where.join(" AND ")} ORDER BY created_at, id`, params);
  return rows.map(mapRow);
}

/** Every stored grant, expired ones included (the console lists them). */
export async function listAll(tenant?: string): Promise<AgentGrantRow[]> {
  const filter = tenant !== undefined && dbDialect() === "pg";
  const rows = await db.query<Row>(
    `SELECT * FROM agent_grants ${filter ? "WHERE tenant_id = ?" : ""} ORDER BY persona, created_at, id`,
    filter ? [tenant] : [],
  );
  return rows.map(mapRow);
}

/** Hard delete. True when a row was removed. */
export async function revoke(id: string): Promise<boolean> {
  const r = await db.run(`DELETE FROM agent_grants WHERE id = ?`, [id]);
  return r.changes > 0;
}

type Row = {
  id: string;
  tenant_id?: string;
  persona: string;
  subject_kind: string;
  subject_id: string;
  role: string;
  deny: boolean | number;
  dm_only: boolean | number;
  created_by: string;
  created_at: number | string;
  expires_at: number | string | null;
  note: string | null;
};

function mapRow(r: Row): AgentGrantRow {
  return {
    id: r.id,
    tenantId: r.tenant_id ?? DEFAULT_TENANT,
    persona: r.persona,
    subjectKind: r.subject_kind as SubjectKind,
    subjectId: r.subject_id,
    role: r.role as GrantRole,
    deny: Boolean(r.deny),
    dmOnly: Boolean(r.dm_only),
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    note: r.note,
  };
}
