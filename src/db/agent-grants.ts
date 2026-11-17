import { randomUUID } from "node:crypto";
import { db, dbDialect } from "./schema";
import { formatRef, parseRef } from "../refs/parse";
import type { Ref } from "../refs/types";
import * as Domain from "./domain";
import { env } from "../config/env";

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
  /** The typed reference of a user or channel subject (`slack:user:T0.../U...`); null for a workspace subject and for old rows. Slack only until the access flip. */
  subjectRef: string | null;
  /** The internal user the subject resolved to when the grant was made (or the reconciler later filled); null when unknown. */
  subjectUserId: string | null;
}

export interface CreateGrantInput {
  tenantId?: string;
  persona: string;
  /** With `subject`, may be left out; when given it must agree with the reference. */
  subjectKind?: SubjectKind;
  subjectId?: string;
  /**
   * A typed reference naming the subject (`slack:user:T0EXAMPLE/U0EXAMPLE`,
   * `slack:channel:C0EXAMPLE`). `email:<address>` and `user:<id>` are accepted
   * only while SLAUDE_ACCESS_SOURCE=internal; under any other source they are
   * refused, so no grant exists that the legacy readers would have to ignore.
   */
  subject?: string;
  role: GrantRole;
  deny?: boolean;
  dmOnly?: boolean;
  createdBy: string;
  expiresAt?: number | null;
  note?: string | null;
}

const DEFAULT_TENANT = "default";

/**
 * Slack id shape per subject kind: uppercase alphanumerics after the prefix
 * Slack uses for that kind of object. user: U or W (Enterprise Grid); channel:
 * C (public) or G (private or group DM); workspace: T. A DM (D) is not a
 * channel subject: a user member grant with dm_only covers it.
 */
const SUBJECT_ID_RE: Record<SubjectKind, { re: RegExp; shape: string }> = {
  user: { re: /^[UW][A-Z0-9]+$/, shape: "a Slack user id (U or W followed by uppercase letters and digits)" },
  channel: { re: /^[CG][A-Z0-9]+$/, shape: "a Slack channel id (C or G followed by uppercase letters and digits)" },
  workspace: { re: /^T[A-Z0-9]+$/, shape: "a Slack workspace id (T followed by uppercase letters and digits)" },
};

type ChangeListener = (persona: string | null) => void;
const listeners = new Set<ChangeListener>();

/** Called after every create (with its persona) and revoke (null: the persona
 *  is not read back). In-process only; other replicas wait out their cache TTL. */
export function onGrantsChanged(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(persona: string | null) {
  for (const fn of listeners) {
    try {
      fn(persona);
    } catch { /* a listener never fails the write */ }
  }
}

/** The kind, id and typed reference a grant input names, or an Error naming the problem. */
function subjectOf(input: CreateGrantInput): { kind: SubjectKind; id: string; ref: string | null; workspace?: string; person?: Ref } {
  if (input.subject !== undefined) {
    const parsed = parseRef(input.subject, ["user", "channel"]);
    if (!parsed.ok) throw new Error("agent grant: subject is not a valid reference");
    const r = parsed.ref;
    if (r.kind === "email" || (r.kind === "internal" && r.type === "user")) {
      // A person by email or by internal user: only when the access source is `internal`.
      if (env.access.source() !== "internal") throw new Error("agent grant: a non-Slack subject is not supported until the access flip");
      if (input.subjectKind && input.subjectKind !== "user") throw new Error("agent grant: subject does not match subject_kind and subject_id");
      const text = formatRef(r);
      if (input.subjectId && input.subjectId !== text) throw new Error("agent grant: subject does not match subject_kind and subject_id");
      return { kind: "user", id: text, ref: text, person: r };
    }
    if (r.kind !== "external" || r.service !== "slack" || (r.type !== "user" && r.type !== "channel")) {
      throw new Error("agent grant: a non-Slack subject is not supported until the access flip");
    }
    if ((input.subjectKind && input.subjectKind !== r.type) || (input.subjectId && input.subjectId !== r.id)) {
      throw new Error("agent grant: subject does not match subject_kind and subject_id");
    }
    return { kind: r.type, id: r.id, ref: formatRef(r), ...(r.workspace ? { workspace: r.workspace } : {}) };
  }
  if (!SUBJECT_KINDS.includes(input.subjectKind as SubjectKind)) throw new Error(`agent grant: invalid subject_kind ${JSON.stringify(input.subjectKind)}`);
  if (!input.subjectId) throw new Error("agent grant: subject_id is required");
  return { kind: input.subjectKind as SubjectKind, id: input.subjectId, ref: null };
}

export async function create(input: CreateGrantInput, now: number = Date.now()): Promise<AgentGrantRow> {
  if (!GRANT_ROLES.includes(input.role)) throw new Error(`agent grant: invalid role ${JSON.stringify(input.role)}`);
  if (input.subject === undefined && input.subjectKind === undefined && input.subjectId === undefined) throw new Error("agent grant: subject is required");
  if (!input.persona) throw new Error("agent grant: persona is required");
  const subj = subjectOf(input);
  const subjectKind = subj.kind;
  const subjectId = subj.id;
  if (subjectKind !== "user") {
    if (input.role !== "member") throw new Error(`agent grant: a ${subjectKind} subject can only be granted member, not ${input.role}`);
    if (input.deny) throw new Error(`agent grant: deny applies to user subjects only, not ${subjectKind}`);
    if (input.dmOnly) throw new Error(`agent grant: dm_only applies to user subjects only, not ${subjectKind}`);
  }
  if (subjectKind === "channel" && /^D[A-Z0-9]+$/.test(subjectId)) {
    throw new Error(
      `agent grant: a channel subject_id must be a channel, not a DM (${JSON.stringify(subjectId)}); DMs are covered by a user member grant with dm_only`,
    );
  }
  // Any reference that is not a bare Slack id (email, internal user, phone, a
  // typed slack: reference) waits for the access flip: the legacy readers and
  // the approval allowlist only understand Slack ids. A typed Slack reference
  // goes in `subject`, not here.
  if (!subj.person && /[:@]/.test(subjectId)) {
    throw new Error("agent grant: a non-Slack subject is not supported until the access flip");
  }
  const idShape = SUBJECT_ID_RE[subjectKind];
  if (!subj.person && !idShape.re.test(subjectId)) {
    throw new Error(`agent grant: a ${subjectKind} subject_id must be ${idShape.shape}, got ${JSON.stringify(subjectId)}`);
  }
  // The typed reference to keep: given, or the short form of the bare id. A workspace subject has none.
  let subjectRef = subj.ref;
  if (!subjectRef && subjectKind !== "workspace") {
    const ref: Ref = { kind: "external", service: "slack", type: subjectKind, id: subjectId };
    subjectRef = formatRef(ref);
  }
  // The user, only when the binding already exists and the workspace is known; never creates a record.
  let subjectUserId: string | null = null;
  if (subj.person) {
    // An email is a declared binding until someone proves it (a declared binding grants nothing); a `user:` reference must name a record that exists.
    if (subj.person.kind === "email") {
      const r = await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: subj.person.address, state: "declared", source: "grant" });
      subjectUserId = r.userId;
    } else if (subj.person.kind === "internal") {
      const live = await Domain.resolveUserId(subj.person.id);
      if (!live) throw new Error("agent grant: that user reference names no record");
      subjectUserId = live;
    }
  } else if (subjectKind === "user" && subj.workspace) {
    try {
      subjectUserId = (await Domain.findBinding({ service: "slack", kind: "user", workspace: subj.workspace, value: subjectId }))?.user_id ?? null;
    } catch {
      subjectUserId = null;
    }
  }
  const row: AgentGrantRow = {
    id: randomUUID(),
    tenantId: input.tenantId ?? DEFAULT_TENANT,
    persona: input.persona,
    subjectKind,
    subjectId,
    role: input.role,
    deny: input.deny ?? false,
    dmOnly: input.dmOnly ?? false,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
    note: input.note ?? null,
    subjectRef,
    subjectUserId,
  };
  const pg = dbDialect() === "pg";
  const bool = (b: boolean) => (pg ? b : b ? 1 : 0);
  const cols = ["id", "persona", "subject_kind", "subject_id", "role", "deny", "dm_only", "created_by", "created_at", "expires_at", "note", "subject_ref", "subject_user_id"];
  const params: unknown[] = [
    row.id, row.persona, row.subjectKind, row.subjectId, row.role, bool(row.deny), bool(row.dmOnly),
    row.createdBy, row.createdAt, row.expiresAt, row.note, row.subjectRef, row.subjectUserId,
  ];
  if (pg) {
    cols.push("tenant_id");
    params.push(row.tenantId);
  }
  await db.run(`INSERT INTO agent_grants (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params);
  changed(row.persona);
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

/** One stored grant by id, expired or not; null when there is none. */
export async function findById(id: string): Promise<AgentGrantRow | null> {
  const r = await db.one<Row>(`SELECT * FROM agent_grants WHERE id = ?`, [id]);
  return r ? mapRow(r) : null;
}

/** Hard delete. True when a row was removed. */
export async function revoke(id: string): Promise<boolean> {
  const r = await db.run(`DELETE FROM agent_grants WHERE id = ?`, [id]);
  if (r.changes > 0) changed(null);
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
  subject_ref?: string | null;
  subject_user_id?: string | null;
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
    subjectRef: r.subject_ref ?? null,
    subjectUserId: r.subject_user_id ?? null,
  };
}
