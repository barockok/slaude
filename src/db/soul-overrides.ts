import { db, dbDialect, getSqliteRaw } from "./client";

export type OverrideField =
  | "trustedChannels"
  | "allowedChannels"
  | "dmAllowedUsers"
  | "blockedUsers";
export type OverrideAction = "add" | "remove";

export type OverrideRow = {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
  created_at: number;
};

const SELECT_ALL = `SELECT field, value, action, created_by, created_at
                    FROM soul_overrides ORDER BY created_at, field, value`;

/**
 * Read-through cache of the (tiny) overrides table.
 *
 * `soulData()` (src/soul/extract.ts) is synchronous and consulted on every
 * inbound message, so it cannot await a Postgres round-trip. Writes in this
 * module refresh the cache (write-through); {@link refresh} re-reads from the
 * store. Under sqlite a cold cache is filled synchronously so behaviour is
 * unchanged; under Postgres the gateway primes it at boot via refresh().
 * Cross-replica staleness is accepted for M1 (single process).
 */
let cache: OverrideRow[] | null = null;

function rowsFrom(raw: OverrideRow[]): OverrideRow[] {
  return raw.map((r) => ({ ...r }));
}

/** Re-read the table into the cache and return the rows. */
export async function refresh(): Promise<OverrideRow[]> {
  const rows = await db.query<OverrideRow>(SELECT_ALL);
  cache = rowsFrom(rows);
  return rowsFrom(cache);
}

/** One verdict per (field, value): an upsert overwrites the previous action. */
export async function upsert(i: {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
}): Promise<void> {
  await db.run(
    `INSERT INTO soul_overrides (field, value, action, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(field, value) DO UPDATE SET
       action = excluded.action,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
    [i.field, i.value, i.action, i.created_by, Date.now()],
  );
  await refresh();
}

export async function list(): Promise<OverrideRow[]> {
  return refresh();
}

/**
 * Synchronous view for the hot path. sqlite: reads through on a cold cache.
 * Postgres: returns the cached rows (empty until the first refresh/list/upsert
 * completes; a refresh is kicked off so the next call sees them).
 */
export function listSync(): OverrideRow[] {
  if (cache) return rowsFrom(cache);
  if (dbDialect() === "sqlite") {
    cache = rowsFrom(getSqliteRaw()!.query(SELECT_ALL).all() as OverrideRow[]);
    return rowsFrom(cache);
  }
  void refresh().catch(() => {});
  return [];
}

export async function clear(field?: OverrideField): Promise<void> {
  if (field) await db.run(`DELETE FROM soul_overrides WHERE field = ?`, [field]);
  else await db.run(`DELETE FROM soul_overrides`);
  await refresh();
}

/** Test hook: forget the cache (e.g. after wiping the table directly). */
export function __resetCacheForTests() {
  cache = null;
}
