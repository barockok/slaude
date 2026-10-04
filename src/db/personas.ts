// src/db/personas.ts
/**
 * The two persona layers and the live revision. This is the only module that
 * reads or writes persona_overrides and persona_sync_state, and the only one
 * that encrypts personas.user_token or any mcp value.
 *
 * Effective state comes from mergeEffective (src/persona/effective.ts); nothing
 * here combines the layers itself.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { encrypt, decrypt, isEncrypted } from "./crypto";
import { mergeEffective, sameDesired, type DesiredPersona, type EffectivePersona, type Override, type OverrideField } from "../persona/effective";

/** The persona tables exist on Postgres only; sqlite has no persona sync. */
export const PERSONA_SYNC_NEEDS_PG = "persona sync requires Postgres (SLAUDE_DB=pg); this deployment runs on sqlite";

export class NotManagedError extends Error {
  readonly status = 409 as const;
  constructor(tenant: string) { super(`tenant '${tenant}' is not managed as code yet — run a sync first`); }
}
export class NameTakenError extends Error {
  readonly status = 409 as const;
  constructor(name: string) { super(`persona '${name}' is managed in git`); }
}
export class IdentityTakenError extends Error {
  readonly status = 409 as const;
  constructor(name: string) { super(`persona '${name}' cannot take a Slack identity another persona already uses`); }
}
export class PersonaNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(name: string) { super(`no live persona named '${name}'`); }
}
export class StaleRevisionError extends Error {
  readonly status = 409 as const;
  constructor(readonly live: string) { super(`a newer revision is live (${live})`); }
}

export interface ApplyResult {
  created: string[]; updated: string[]; unchanged: string[]; tombstoned: string[]; overridesWiped: number;
}

type Row = {
  name: string; slack_user_id: string | null; user_token: string | null; model_default: string | null;
  soul_md: string; soul_json: unknown; mcp_json: unknown; provider_json: unknown; runs_on: string | null; kb_sources: unknown;
  origin: "git" | "runtime"; tombstoned_at: number | null;
};

const ROW_COLUMNS =
  "name, slack_user_id, user_token, model_default, soul_md, soul_json, mcp_json, provider_json, runs_on, kb_sources, origin, tombstoned_at";

// provider_json holds references only (WS-A §4), never a value, so it is
// stored as plain JSONB: an operator can read which secret a persona names.
const providerJson = (p: DesiredPersona["provider"]) => (p ? JSON.stringify(p) : null);
// kb_sources: null = every installed KB, [] = none (WS-C §4.1), so an empty
// array is stored as itself, never collapsed to null.
const kbSourcesJson = (k: DesiredPersona["kbSources"]) => (k == null ? null : JSON.stringify(k));

// mcp is stored as an encrypted string inside the JSONB column, so the column
// type stays as 0001 defined it while the value is never plaintext at rest.
const encJson = (v: unknown) => (v == null ? null : JSON.stringify(encrypt(JSON.stringify(v))));
const decJson = (v: unknown) => {
  if (v == null) return null;
  // The driver may hand back the JSONB string already parsed (the envelope) or
  // still JSON-quoted; either way the plaintext is only ever the decrypted value.
  let s: unknown = v;
  if (typeof s === "string" && !isEncrypted(s)) s = JSON.parse(s);
  return typeof s === "string" && isEncrypted(s) ? JSON.parse(decrypt(s)) : s;
};
const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

function toDesired(r: Row): DesiredPersona {
  return {
    name: r.name,
    slackUserId: r.slack_user_id,
    userToken: r.user_token ? decrypt(r.user_token) : null,
    model: r.model_default,
    soulMd: r.soul_md,
    soulJson: parseJson(r.soul_json),
    mcp: decJson(r.mcp_json),
    provider: (parseJson(r.provider_json) as DesiredPersona["provider"]) ?? null,
    runsOn: r.runs_on ?? null,
    kbSources: (parseJson(r.kb_sources) as string[] | null) ?? null,
    origin: r.origin,
    tombstonedAt: r.tombstoned_at == null ? null : Number(r.tombstoned_at),
  };
}

export async function syncState(tenant: string) {
  const r = await db.one<{ revision: string; committed_at: number; override_version: number }>(
    `SELECT revision, committed_at, override_version FROM persona_sync_state WHERE tenant_id = ?`, [tenant]);
  return r ? { revision: r.revision, committedAt: Number(r.committed_at), overrideVersion: Number(r.override_version) } : null;
}

/**
 * Whether migration 0014 (personas.provider_json) is applied. A gateway run
 * with SLAUDE_MIGRATE_ON_BOOT=0 against an older schema would otherwise fail a
 * sync with a raw SQL error; sync checks this first and refuses by name.
 */
export async function providerColumnPresent(): Promise<boolean> {
  return personasColumnPresent("provider_json");
}

/** Whether migration 0017 (personas.kb_sources) is applied; same reason. */
export async function kbSourcesColumnPresent(): Promise<boolean> {
  return personasColumnPresent("kb_sources");
}

async function personasColumnPresent(column: string): Promise<boolean> {
  const r = await db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'personas' AND column_name = ?`, [column]);
  return Number(r?.n ?? 0) > 0;
}

export async function isManaged(tenant: string): Promise<boolean> {
  return (await syncState(tenant)) !== null;
}

export async function stateVersion(tenant: string): Promise<string> {
  const s = await syncState(tenant);
  return s ? `${s.revision}:${s.overrideVersion}` : "unmanaged";
}

async function desiredRows(tenant: string, opts: { includeTombstoned?: boolean }): Promise<Row[]> {
  return db.query<Row>(
    `SELECT ${ROW_COLUMNS}
     FROM personas WHERE tenant_id = ? ${opts.includeTombstoned ? "" : "AND tombstoned_at IS NULL"} ORDER BY name`,
    [tenant]);
}

/** The git-desired layer only: no overrides applied. */
export async function desiredPersonas(tenant: string, opts: { includeTombstoned?: boolean } = {}): Promise<DesiredPersona[]> {
  return (await desiredRows(tenant, opts)).map(toDesired);
}

export async function effectivePersonas(tenant: string, opts: { includeTombstoned?: boolean } = {}): Promise<EffectivePersona[]> {
  const rows = await desiredRows(tenant, opts);
  const ovs = await db.query<{ persona_name: string; field: OverrideField; value: string }>(
    `SELECT persona_name, field, value FROM persona_overrides WHERE tenant_id = ?`, [tenant]);
  return rows.map((r) => mergeEffective(
    toDesired(r),
    ovs.filter((o) => o.persona_name === r.name).map((o): Override => ({ field: o.field, value: JSON.parse(decrypt(o.value)) })),
  ));
}

export async function applySync(
  tenant: string,
  rows: DesiredPersona[],
  meta: { revision: string; committedAt: number; by: string },
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const now = Date.now();
    // override_version counts EVERY write to the tenant's persona state (syncs
    // included), never resets, so stateVersion never repeats after a change.
    // The ordering check and the write are one statement, so two concurrent
    // syncs cannot both pass it. Same shape as CronJobs.claimDue.
    await tx.run(`INSERT INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?) ON CONFLICT (id) DO NOTHING`,
      [tenant, tenant, now]);
    const claimed = await tx.query<{ tenant_id: string }>(
      `INSERT INTO persona_sync_state (tenant_id, revision, committed_at, synced_at, synced_by, override_version)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET
         revision = excluded.revision, committed_at = excluded.committed_at,
         synced_at = excluded.synced_at, synced_by = excluded.synced_by,
         override_version = persona_sync_state.override_version + 1
       WHERE persona_sync_state.committed_at <= excluded.committed_at
       RETURNING tenant_id`,
      [tenant, meta.revision, meta.committedAt, now, meta.by]);
    if (!claimed.length) {
      const live = await tx.one<{ revision: string }>(`SELECT revision FROM persona_sync_state WHERE tenant_id = ?`, [tenant]);
      throw new StaleRevisionError(live?.revision ?? "unknown");
    }

    const existing = new Map(
      (await tx.query<Row>(`SELECT ${ROW_COLUMNS} FROM personas WHERE tenant_id = ?`, [tenant])).map((r) => [r.name, toDesired(r)]));
    const result: ApplyResult = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0 };
    const incoming = new Set(rows.map((r) => r.name));

    for (const r of rows) {
      const prev = existing.get(r.name);
      if (!prev) result.created.push(r.name);
      else if (prev.origin === "git" && sameDesired(prev, r)) result.unchanged.push(r.name);
      else result.updated.push(r.name);
      await tx.run(
        `INSERT INTO personas (id, tenant_id, name, soul_md, soul_json, soul_sha, model_default, mcp_json, provider_json, runs_on, kb_sources,
                               slack_user_id, user_token, origin, source_revision, tombstoned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'git', ?, NULL, ?, ?)
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           soul_md = excluded.soul_md, soul_json = excluded.soul_json, model_default = excluded.model_default,
           mcp_json = excluded.mcp_json, provider_json = excluded.provider_json, runs_on = excluded.runs_on, kb_sources = excluded.kb_sources,
           slack_user_id = excluded.slack_user_id, user_token = excluded.user_token,
           origin = 'git', source_revision = excluded.source_revision, tombstoned_at = NULL, updated_at = excluded.updated_at`,
        [randomUUID(), tenant, r.name, r.soulMd, JSON.stringify(r.soulJson ?? null), r.model, encJson(r.mcp),
         providerJson(r.provider), r.runsOn ?? null, kbSourcesJson(r.kbSources), r.slackUserId, r.userToken ? encrypt(r.userToken) : null, meta.revision, now, now]);
    }
    for (const [name, prev] of existing) {
      if (incoming.has(name) || prev.tombstonedAt !== null) continue;
      await tx.run(`UPDATE personas SET tombstoned_at = ? WHERE tenant_id = ? AND name = ?`, [now, tenant, name]);
      result.tombstoned.push(name);
    }
    const wiped = await tx.run(`DELETE FROM persona_overrides WHERE tenant_id = ?`, [tenant]);
    result.overridesWiped = wiped.changes ?? 0;
    return result;
  });
}

async function requireManaged(tenant: string) {
  if (!(await isManaged(tenant))) throw new NotManagedError(tenant);
}

export async function setOverride(tenant: string, name: string, field: OverrideField, value: unknown, by: string) {
  await requireManaged(tenant);
  await db.transaction(async (tx) => {
    // First statement: the sync-state row lock serialises with applySync, whose first write is the same row.
    await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
    const live = await tx.one<{ name: string }>(
      `SELECT name FROM personas WHERE tenant_id = ? AND name = ? AND tombstoned_at IS NULL`, [tenant, name]);
    if (!live) throw new PersonaNotFoundError(name);
    await tx.run(
      `INSERT INTO persona_overrides (tenant_id, persona_name, field, value, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, persona_name, field) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      [tenant, name, field, encrypt(JSON.stringify(value)), by, Date.now()]);
  });
}

export async function clearOverride(tenant: string, name: string, field: OverrideField): Promise<boolean> {
  await requireManaged(tenant);
  return db.transaction(async (tx) => {
    // First statement: the sync-state row lock serialises with applySync, whose first write is the same row.
    await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
    const r = await tx.run(`DELETE FROM persona_overrides WHERE tenant_id = ? AND persona_name = ? AND field = ?`, [tenant, name, field]);
    return (r.changes ?? 0) > 0;
  });
}

export async function createRuntimePersona(tenant: string, row: DesiredPersona, by: string) {
  await requireManaged(tenant);
  await db.transaction(async (tx) => {
    // First statement: the sync-state row lock serialises with applySync, whose first write is the same row.
    await tx.run(`UPDATE persona_sync_state SET override_version = override_version + 1 WHERE tenant_id = ?`, [tenant]);
    const taken = await tx.one<{ origin: string }>(`SELECT origin FROM personas WHERE tenant_id = ? AND name = ?`, [tenant, row.name]);
    if (taken?.origin === "git") throw new NameTakenError(row.name);
    if (row.slackUserId) {
      const dup = await tx.one<{ name: string }>(
        `SELECT name FROM personas WHERE tenant_id = ? AND slack_user_id = ? AND name <> ? AND tombstoned_at IS NULL`,
        [tenant, row.slackUserId, row.name]);
      if (dup) throw new IdentityTakenError(row.name);
    }
    const now = Date.now();
    const written = await tx.query<{ name: string }>(
      `INSERT INTO personas (id, tenant_id, name, soul_md, soul_json, model_default, mcp_json, provider_json, runs_on, kb_sources, slack_user_id, user_token,
                             origin, source_revision, tombstoned_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime', NULL, NULL, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         soul_md = excluded.soul_md, soul_json = excluded.soul_json, model_default = excluded.model_default,
         mcp_json = excluded.mcp_json, provider_json = excluded.provider_json, runs_on = excluded.runs_on, kb_sources = excluded.kb_sources,
         slack_user_id = excluded.slack_user_id, user_token = excluded.user_token,
         tombstoned_at = NULL, updated_at = excluded.updated_at
       WHERE personas.origin = 'runtime'
       RETURNING name`,
      [randomUUID(), tenant, row.name, row.soulMd, JSON.stringify(row.soulJson ?? null), row.model, encJson(row.mcp),
       providerJson(row.provider), row.runsOn ?? null, kbSourcesJson(row.kbSources), row.slackUserId, row.userToken ? encrypt(row.userToken) : null, now, now]);
    // A git row appeared after the read above: never overwrite it.
    if (!written.length) throw new NameTakenError(row.name);
    void by; // recorded in the audit log by the caller (Task 7)
  });
}
