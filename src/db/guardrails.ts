/**
 * Owner guardrail storage (migration 0033; sqlite bootstrap in
 * drivers/sqlite.ts). The database is the only runtime source of a guardrail.
 *
 * Every write goes through {@link applyGuardrailChange}: one transaction that
 * bumps the tenant's manifest version, writes the changed rows with that
 * version and their HMACs, and re-signs the manifest over the resulting set.
 * Reads return the stored set as is; src/guardrails/integrity.ts verifies it.
 *
 * tenant_id exists on Postgres only; sqlite has one tenant ('default').
 */
import { createHash } from "node:crypto";
import { db, dbDialect, type DbClient } from "./client";
import { manifestEntries, manifestMac, overrideMac, rowMac, verifySet, type StoredSet } from "../guardrails/integrity";
import { __resetHighWaterForTests, checkHighWater, highWater, raiseHighWater } from "../guardrails/high-water";

export type GuardrailSource = "file" | "git" | "console";

export interface GuardrailRow {
  slug: string;
  md: string;
  sha: string;
  source: GuardrailSource;
  version: number;
  enabled: boolean;
  hmac: string;
  updatedAt: number;
  updatedBy: string;
}

export interface GuardrailOverrideRow {
  slug: string;
  md: string;
  baseSha: string;
  version: number;
  author: string;
  hmac: string;
  updatedAt: number;
}

export interface StoredGuardrails extends StoredSet {
  rows: GuardrailRow[];
  overrides: GuardrailOverrideRow[];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const pg = () => dbDialect() === "pg";
const tenantWhere = (alias = "") => (pg() ? ` WHERE ${alias}tenant_id = ?` : "");
const tenantParams = (tenant: string) => (pg() ? [tenant] : []);

type RawRow = { slug: string; md: string; sha: string; source: string; version: number; enabled: boolean | number; hmac: string; updated_at: number; updated_by: string };
type RawOverride = { slug: string; md: string; base_sha: string; version: number; author: string; hmac: string; updated_at: number };

const toRow = (r: RawRow): GuardrailRow => ({
  slug: r.slug, md: r.md, sha: r.sha, source: r.source as GuardrailSource, version: Number(r.version), enabled: Boolean(r.enabled),
  hmac: r.hmac, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});
const toOverride = (o: RawOverride): GuardrailOverrideRow => ({
  slug: o.slug, md: o.md, baseSha: o.base_sha, version: Number(o.version), author: o.author, hmac: o.hmac, updatedAt: Number(o.updated_at),
});

async function readWith(c: DbClient, tenant: string, lock = false): Promise<StoredGuardrails> {
  const manifest = await c.one<{ version: number; entries: string; hmac: string }>(
    `SELECT version, entries, hmac FROM guardrails_manifest${tenantWhere()}${pg() && lock ? " FOR UPDATE" : ""}`,
    tenantParams(tenant),
  );
  const rows = (await c.query<RawRow>(`SELECT slug, md, sha, source, version, enabled, hmac, updated_at, updated_by FROM guardrails${tenantWhere()} ORDER BY slug`, tenantParams(tenant))).map(toRow);
  const overrides = (await c.query<RawOverride>(`SELECT slug, md, base_sha, version, author, hmac, updated_at FROM guardrail_overrides${tenantWhere()} ORDER BY slug`, tenantParams(tenant))).map(toOverride);
  return { rows, overrides, manifest: manifest ? { version: Number(manifest.version), entries: manifest.entries, hmac: manifest.hmac } : null };
}

/** The stored set of one tenant, unverified. */
export function readGuardrails(tenant = "default"): Promise<StoredGuardrails> {
  return readWith(db, tenant);
}

/** The manifest version alone (0 when none): a cheap change probe. */
export async function manifestVersion(tenant = "default"): Promise<number> {
  const m = await db.one<{ version: number }>(`SELECT version FROM guardrails_manifest${tenantWhere()}`, tenantParams(tenant));
  return m ? Number(m.version) : 0;
}

export interface GuardrailChange {
  /** Insert or replace these guardrails' text (a replaced row keeps its enabled flag). */
  upsert?: Array<{ slug: string; md: string; source: GuardrailSource }>;
  /** Delete these guardrails (and any override of them). */
  remove?: string[];
  /** Flip the console kill switch. */
  setEnabled?: Array<{ slug: string; enabled: boolean }>;
  /**
   * Write a console override of these guardrails (their source row stays as
   * synced). base_sha is the source row's sha at the time of the write, so a
   * later sync that changes the source shows the override behind source.
   */
  setOverride?: Array<{ slug: string; md: string }>;
  /** Drop these guardrails' console overrides (the source text applies again). */
  clearOverride?: string[];
  /**
   * Optimistic concurrency: each slug's revision must still be the one the
   * writer read (null: the guardrail must not exist yet). Checked inside the
   * transaction, so a concurrent write is a StaleGuardrailError, never lost.
   */
  expect?: Array<{ slug: string; revision: number | null }>;
  /** Who made the change (operator id, "pipeline", "cli:<user>"). */
  by: string;
  /**
   * The owner's repair (`slaude guardrails import --repair`): skip the check
   * of the stored set and re-sign every row and override as stored, at a
   * version above anything seen. Without it a write refuses a set that does
   * not verify, so a write can never launder tampering.
   */
  repair?: boolean;
}

export interface ChangeResult {
  version: number;
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  toggled: string[];
  /** Overrides written or replaced. */
  overrideSet: string[];
  /** Overrides dropped (a removed guardrail's override is not listed here). */
  overrideCleared: string[];
  /** Repair only: rows and overrides re-signed as stored (check them). */
  resigned?: string[];
}

export class UnknownGuardrailError extends Error {
  constructor(readonly slug: string) {
    super(`no guardrail named '${slug}'`);
  }
}

/** A write against a revision that is no longer current (someone else wrote first). */
export class StaleGuardrailError extends Error {
  constructor(readonly slug: string, readonly expected: number | null, readonly current: number | null) {
    super(
      current === null
        ? `guardrail '${slug}' no longer exists`
        : expected === null
          ? `a guardrail named '${slug}' already exists`
          : `guardrail '${slug}' changed since it was loaded (revision ${expected}, now ${current})`,
    );
  }
}

/**
 * A guardrail's revision: the manifest version of its last write, its source
 * row's or its override's, whichever is later. Moves on every change to the
 * text, the source, the override or the switch.
 */
export function guardrailRevision(row: Pick<GuardrailRow, "version"> | undefined, override: Pick<GuardrailOverrideRow, "version"> | undefined): number | null {
  if (!row) return null;
  return Math.max(row.version, override?.version ?? 0);
}

/**
 * Apply one change atomically and re-sign the set. A change that alters
 * nothing writes nothing (the version does not move).
 */
export async function applyGuardrailChange(tenant: string, change: GuardrailChange, now = Date.now()): Promise<ChangeResult> {
  const r = await writeChange(tenant, change, now);
  await raiseHighWater(tenant, r.version);
  return r;
}

function writeChange(tenant: string, change: GuardrailChange, now: number): Promise<ChangeResult> {
  return db.transaction(async (tx) => {
    if (pg()) {
      await tx.run(
        `INSERT INTO guardrails_manifest (tenant_id, id, version, entries, hmac, updated_at) VALUES (?, 'manifest', 0, '{"rows":[],"overrides":[]}', '', ?) ON CONFLICT (tenant_id, id) DO NOTHING`,
        [tenant, now],
      );
    }
    const cur = await readWith(tx, tenant, true);
    const stored = cur.manifest?.version ?? 0;
    // Never re-sign over a set that does not verify (or is older than one seen
    // before): that would launder tampering into a valid signature.
    if (!change.repair) {
      verifySet(tenant, cur);
      await checkHighWater(tenant, stored);
    }
    for (const e of change.expect ?? []) {
      const row = cur.rows.find((r) => r.slug === e.slug);
      const now_ = guardrailRevision(row, cur.overrides.find((o) => o.slug === e.slug));
      if (now_ !== e.revision) throw new StaleGuardrailError(e.slug, e.revision, now_);
    }
    const res: ChangeResult = { version: stored, created: [], updated: [], unchanged: [], removed: [], toggled: [], overrideSet: [], overrideCleared: [] };
    const version = (change.repair ? Math.max(stored, await highWater(tenant)) : stored) + 1;
    const bySlug = new Map(cur.rows.map((r) => [r.slug, r]));
    const writes: GuardrailRow[] = [];
    for (const u of change.upsert ?? []) {
      const prev = bySlug.get(u.slug);
      const sha = sha256(u.md);
      // The text itself, not the stored sha: a repair must replace a row whose text was edited under its old sha.
      if (prev && prev.md === u.md && prev.sha === sha && prev.source === u.source) {
        res.unchanged.push(u.slug);
        continue;
      }
      const enabled = prev?.enabled ?? true;
      const row: GuardrailRow = { slug: u.slug, md: u.md, sha, source: u.source, version, enabled, hmac: "", updatedAt: now, updatedBy: change.by };
      row.hmac = rowMac(tenant, row);
      writes.push(row);
      bySlug.set(u.slug, row);
      (prev ? res.updated : res.created).push(u.slug);
    }
    for (const t of change.setEnabled ?? []) {
      const prev = bySlug.get(t.slug);
      if (!prev) throw new UnknownGuardrailError(t.slug);
      if (prev.enabled === t.enabled) continue;
      const row: GuardrailRow = { ...prev, enabled: t.enabled, version, updatedAt: now, updatedBy: change.by, hmac: "" };
      row.hmac = rowMac(tenant, row);
      const i = writes.findIndex((w) => w.slug === t.slug);
      if (i >= 0) writes[i] = row;
      else writes.push(row);
      bySlug.set(t.slug, row);
      res.toggled.push(t.slug);
    }
    const removed = (change.remove ?? []).filter((s) => bySlug.has(s));
    let overrides = cur.overrides.filter((o) => !removed.includes(o.slug));
    const overrideWrites: GuardrailOverrideRow[] = [];
    const overrideDeletes: string[] = [];
    for (const slug of change.clearOverride ?? []) {
      if (!bySlug.has(slug)) throw new UnknownGuardrailError(slug);
      if (!overrides.some((o) => o.slug === slug)) continue;
      overrides = overrides.filter((o) => o.slug !== slug);
      overrideDeletes.push(slug);
      res.overrideCleared.push(slug);
    }
    for (const o of change.setOverride ?? []) {
      const src = bySlug.get(o.slug);
      if (!src) throw new UnknownGuardrailError(o.slug);
      const prev = overrides.find((x) => x.slug === o.slug);
      if (prev && prev.md === o.md && prev.baseSha === src.sha) continue;
      const row: GuardrailOverrideRow = { slug: o.slug, md: o.md, baseSha: src.sha, version, author: change.by, hmac: "", updatedAt: now };
      row.hmac = overrideMac(tenant, row);
      overrides = [...overrides.filter((x) => x.slug !== o.slug), row];
      overrideWrites.push(row);
      res.overrideSet.push(o.slug);
    }
    if (change.repair) {
      // Every row the change did not write, and every override, re-signed as stored.
      res.resigned = [];
      for (const r of cur.rows) {
        if (removed.includes(r.slug) || writes.some((w) => w.slug === r.slug)) continue;
        const row: GuardrailRow = { ...r, sha: sha256(r.md), version, hmac: "", updatedAt: now, updatedBy: change.by };
        row.hmac = rowMac(tenant, row);
        writes.push(row);
        bySlug.set(r.slug, row);
        res.resigned.push(r.slug);
      }
      overrides = overrides.map((o) => ({ ...o, version, hmac: overrideMac(tenant, { ...o, version }) }));
      for (const o of overrides) {
        await tx.run(`UPDATE guardrail_overrides SET version = ?, hmac = ?, updated_at = ? WHERE slug = ?${pg() ? " AND tenant_id = ?" : ""}`, [o.version, o.hmac, now, o.slug, ...tenantParams(tenant)]);
        res.resigned.push(`${o.slug} (override)`);
      }
    } else if (writes.length === 0 && removed.length === 0 && overrideWrites.length === 0 && overrideDeletes.length === 0) {
      return res;
    }

    const bool = (b: boolean) => (pg() ? b : b ? 1 : 0);
    for (const w of writes) {
      const cols = ["slug", "md", "sha", "source", "version", "enabled", "hmac", "updated_at", "updated_by"];
      const params: unknown[] = [w.slug, w.md, w.sha, w.source, w.version, bool(w.enabled), w.hmac, w.updatedAt, w.updatedBy];
      if (pg()) {
        cols.unshift("tenant_id");
        params.unshift(tenant);
      }
      const set = cols.filter((c) => c !== "tenant_id" && c !== "slug").map((c) => `${c} = excluded.${c}`).join(", ");
      await tx.run(
        `INSERT INTO guardrails (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${pg() ? "tenant_id, slug" : "slug"}) DO UPDATE SET ${set}`,
        params,
      );
    }
    for (const slug of overrideDeletes) {
      await tx.run(`DELETE FROM guardrail_overrides WHERE slug = ?${pg() ? " AND tenant_id = ?" : ""}`, [slug, ...tenantParams(tenant)]);
    }
    for (const o of overrideWrites) {
      const cols = ["slug", "md", "base_sha", "version", "author", "hmac", "updated_at"];
      const params: unknown[] = [o.slug, o.md, o.baseSha, o.version, o.author, o.hmac, o.updatedAt];
      if (pg()) {
        cols.unshift("tenant_id");
        params.unshift(tenant);
      }
      const set = cols.filter((c) => c !== "tenant_id" && c !== "slug").map((c) => `${c} = excluded.${c}`).join(", ");
      await tx.run(
        `INSERT INTO guardrail_overrides (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${pg() ? "tenant_id, slug" : "slug"}) DO UPDATE SET ${set}`,
        params,
      );
    }
    for (const slug of removed) {
      await tx.run(`DELETE FROM guardrails WHERE slug = ?${pg() ? " AND tenant_id = ?" : ""}`, [slug, ...tenantParams(tenant)]);
      await tx.run(`DELETE FROM guardrail_overrides WHERE slug = ?${pg() ? " AND tenant_id = ?" : ""}`, [slug, ...tenantParams(tenant)]);
      bySlug.delete(slug);
      res.removed.push(slug);
    }
    overrides = overrides.filter((o) => bySlug.has(o.slug));
    const entries = manifestEntries([...bySlug.values()], overrides);
    const hmac = manifestMac(tenant, version, entries);
    if (pg()) {
      await tx.run(`UPDATE guardrails_manifest SET version = ?, entries = ?, hmac = ?, updated_at = ? WHERE tenant_id = ? AND id = 'manifest'`, [
        version, JSON.stringify(entries), hmac, now, tenant,
      ]);
    } else {
      await tx.run(
        `INSERT INTO guardrails_manifest (id, version, entries, hmac, updated_at) VALUES ('manifest', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, entries = excluded.entries, hmac = excluded.hmac, updated_at = excluded.updated_at`,
        [version, JSON.stringify(entries), hmac, now],
      );
    }
    res.version = version;
    return res;
  });
}

/** TEST SEAM: write an override row the way phase B's console edit will (signed, in the manifest). */
export async function __setOverrideForTests(tenant: string, o: { slug: string; md: string; baseSha: string; author: string }, now = Date.now()): Promise<number> {
  return db.transaction(async (tx) => {
    const cur = await readWith(tx, tenant, true);
    const version = (cur.manifest?.version ?? 0) + 1;
    const row = { ...o, version };
    const hmac = overrideMac(tenant, row);
    const cols = ["slug", "md", "base_sha", "version", "author", "hmac", "updated_at"];
    const params: unknown[] = [o.slug, o.md, o.baseSha, version, o.author, hmac, now];
    if (pg()) {
      cols.unshift("tenant_id");
      params.unshift(tenant);
    }
    await tx.run(`INSERT INTO guardrail_overrides (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params);
    const overrides = [...cur.overrides.filter((x) => x.slug !== o.slug), { slug: o.slug, version }];
    const entries = manifestEntries(cur.rows, overrides);
    const mh = manifestMac(tenant, version, entries);
    if (pg()) {
      await tx.run(`UPDATE guardrails_manifest SET version = ?, entries = ?, hmac = ?, updated_at = ? WHERE tenant_id = ? AND id = 'manifest'`, [version, JSON.stringify(entries), mh, now, tenant]);
    } else {
      await tx.run(`UPDATE guardrails_manifest SET version = ?, entries = ?, hmac = ?, updated_at = ? WHERE id = 'manifest'`, [version, JSON.stringify(entries), mh, now]);
    }
    return version;
  });
}

/** TEST SEAM: every guardrail table emptied (persistent test Postgres). */
export async function __clearGuardrailsForTests(): Promise<void> {
  for (const t of ["guardrails", "guardrail_overrides", "guardrails_manifest"]) await db.run(`DELETE FROM ${t}`);
  await __resetHighWaterForTests();
}
