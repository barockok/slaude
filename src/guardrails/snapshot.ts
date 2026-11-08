/**
 * The gateway's (and a mono process's) in-memory guardrail snapshot, per
 * tenant: the stored set read from the database, verified (manifest first,
 * then each row) and parsed. Sessions take their guardrails from it at boot,
 * the same lifecycle as the soul; the inbound check reads it per message.
 *
 * A snapshot that cannot be read or verified is held as a failure: every
 * session boot that needs it fails (audited as guardrail.integrity.failed),
 * never running with an empty set. It is re-read when the manifest version
 * moves: on a local write (refresh), a reload signal, or the poll.
 */
import { manifestVersion, readGuardrails, type StoredGuardrails } from "../db/guardrails";
import { emitAudit } from "../audit/emit";
import { GuardrailIntegrityError, guardrailKey, peekKeySource, verifySet, type KeySource } from "./integrity";
import { __resetHighWaterForTests, checkHighWater, highWater, highWaterInMemory, raiseHighWater } from "./high-water";
export { checkHighWater };
import { resolveDocs, type GuardrailDoc, type ResolvedGuardrail } from "./resolve";

/** The tenant of a single-tenant deployment (sqlite has only this one). */
export const DEFAULT_TENANT = "default";

export interface TenantSnapshot {
  tenant: string;
  version: number;
  resolved: ResolvedGuardrail[];
  /** null: no set and no key yet. */
  keySource: KeySource | null;
  /** The verified stored set it was built from (source texts and revisions for the console). */
  stored: StoredGuardrails;
}

/** The documents of a verified stored set: an override's text wins over its source row. */
export function docsFromStored(s: StoredGuardrails): GuardrailDoc[] {
  const ov = new Map(s.overrides.map((o) => [o.slug, o]));
  return s.rows.map((r) => {
    const o = ov.get(r.slug);
    return { slug: r.slug, md: o ? o.md : r.md, source: r.source, override: !!o, behindSource: !!o && o.baseSha !== r.sha, enabled: r.enabled };
  });
}

/**
 * Read and verify one tenant's set: the manifest and rows (verifySet), then
 * against the high-water mark, so a deleted set or a replayed older signed
 * set fails closed. Throws GuardrailIntegrityError (or a read error).
 */
export async function loadTenantSnapshot(tenant: string): Promise<TenantSnapshot> {
  const stored = await readGuardrails(tenant);
  const version = verifySet(tenant, stored);
  await checkHighWater(tenant, version);
  await raiseHighWater(tenant, version);
  // The key is touched only when a set exists: a deployment with no
  // guardrails reads and creates nothing.
  return { tenant, version, resolved: resolveDocs(docsFromStored(stored)), keySource: version > 0 ? guardrailKey().source : peekKeySource(), stored };
}


/** A snapshot that could not be read or verified. */
export class GuardrailsUnavailableError extends Error {
  constructor(readonly tenant: string, override readonly cause: unknown) {
    super(cause instanceof GuardrailIntegrityError ? cause.message : `guardrails could not be read: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

type Entry = { ok: true; snap: TenantSnapshot } | { ok: false; error: GuardrailsUnavailableError; version: number | null };

const entries = new Map<string, Entry>();
const listeners = new Set<(tenant: string, snap: TenantSnapshot | null) => void>();
const inflight = new Map<string, Promise<Entry>>();
let lastAuditedFailure = new Map<string, string>();

function auditFailure(tenant: string, err: GuardrailsUnavailableError, context: { persona?: string | null; sessionId?: string | null }): void {
  emitAudit({
    tenantId: tenant,
    persona: context.persona ?? null,
    consoleWide: !context.persona,
    actorKind: "system",
    actorId: "guardrails",
    action: "guardrail.integrity.failed",
    targetKind: "guardrails",
    targetId: tenant,
    decision: "refused",
    sessionId: context.sessionId ?? null,
    summary: "guardrails could not be verified; sessions that need them do not start",
    details: { reason: err.message },
  });
}

async function load(tenant: string): Promise<Entry> {
  let entry: Entry;
  try {
    entry = { ok: true, snap: await loadTenantSnapshot(tenant) };
  } catch (e) {
    let v: number | null = null;
    try {
      v = await manifestVersion(tenant);
    } catch {
      v = null;
    }
    entry = { ok: false, error: new GuardrailsUnavailableError(tenant, e), version: v };
    // One audit row per distinct failure, not one per poll.
    if (lastAuditedFailure.get(tenant) !== entry.error.message) {
      lastAuditedFailure.set(tenant, entry.error.message);
      auditFailure(tenant, entry.error, {});
    }
    console.error(`[guardrails] tenant=${tenant}: ${entry.error.message}`);
  }
  const prev = entries.get(tenant);
  entries.set(tenant, entry);
  if (entry.ok) lastAuditedFailure.delete(tenant);
  const changed = !prev || prev.ok !== entry.ok || (entry.ok && prev.ok && prev.snap.version !== entry.snap.version);
  if (changed && prev) for (const fn of [...listeners]) {
    try {
      fn(tenant, entry.ok ? entry.snap : null);
    } catch (e) {
      console.error("[guardrails] change listener failed:", (e as Error).message);
    }
  }
  return entry;
}

/** Re-read a tenant's set now (after a local write or a reload signal). */
export function refreshGuardrails(tenant = "default"): Promise<Entry> {
  const running = inflight.get(tenant);
  if (running) return running.then(() => refreshGuardrails(tenant));
  const p = load(tenant).finally(() => inflight.delete(tenant));
  inflight.set(tenant, p);
  return p;
}

/**
 * The tenant's verified snapshot, re-read first when the stored version moved
 * (one cheap query). Throws GuardrailsUnavailableError when it cannot be read
 * or verified, auditing the refusal against the session that needed it.
 */
export async function currentGuardrails(tenant = "default", context: { persona?: string | null; sessionId?: string | null } = {}): Promise<TenantSnapshot> {
  let entry = entries.get(tenant);
  let stored: number | null = null;
  try {
    stored = await manifestVersion(tenant);
  } catch (e) {
    const err = new GuardrailsUnavailableError(tenant, e);
    auditFailure(tenant, err, context);
    throw err;
  }
  const seen = entry ? (entry.ok ? entry.snap.version : entry.version) : null;
  if (!entry || seen !== stored || !entry.ok) entry = await refreshGuardrails(tenant);
  if (!entry.ok) {
    if (context.sessionId || context.persona) auditFailure(tenant, entry.error, context);
    throw entry.error;
  }
  return entry.snap;
}

/** The last loaded snapshot without touching the database (hot paths), or null when none or failed. */
export function cachedGuardrails(tenant = "default"): TenantSnapshot | null {
  const e = entries.get(tenant);
  return e?.ok ? e.snap : null;
}

/**
 * Whether `tenant` has a guardrail set that its last load could not read or
 * verify: the stored manifest names a version, or the high-water mark says
 * one was seen (a deleted set). A deployment with no guardrails at all has
 * neither, so paths that fail closed only for a set that exists (the
 * outbound choke point) behave there exactly as before guardrails.
 */
export async function failedSetExists(tenant = "default"): Promise<boolean> {
  const e = entries.get(tenant);
  if (e && !e.ok && (e.version ?? 0) > 0) return true;
  try {
    return (await highWater(tenant)) > 0;
  } catch {
    return false;
  }
}

/** failedSetExists without I/O: the failed load's own manifest version, or this process's mark. */
export function failedSetExistsCached(tenant = "default"): boolean {
  const e = entries.get(tenant);
  if (!e || e.ok) return false;
  return (e.version ?? 0) > 0 || highWaterInMemory(tenant) > 0;
}

/** The last load's failure, or null (the console names it). */
export function guardrailsFailure(tenant = "default"): string | null {
  const e = entries.get(tenant);
  return e && !e.ok ? e.error.message : null;
}

/** Told when a tenant's snapshot changed (a new version, or a failure). */
export function onGuardrailsChanged(fn: (tenant: string, snap: TenantSnapshot | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Poll the stored version and reload on a change (other replicas' writes). */
export function startGuardrailRevalidation(tenant = "default", everyMs = 10_000): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const v = await manifestVersion(tenant);
      const e = entries.get(tenant);
      const seen = e ? (e.ok ? e.snap.version : e.version) : null;
      if (seen !== v) await refreshGuardrails(tenant);
    } catch (e) {
      console.warn("[guardrails] revalidation failed:", (e as Error).message);
    } finally {
      running = false;
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** TEST SEAM: forget every snapshot and listener (and the high-water mark). */
export function __resetGuardrailSnapshotsForTests(): void {
  void __resetHighWaterForTests();
  entries.clear();
  inflight.clear();
  listeners.clear();
  lastAuditedFailure = new Map();
}
