/**
 * Numbered SQL migration runner for the Postgres dialect.
 *
 * Files: `src/db/migrations/NNNN_<slug>.sql`, applied in lexical order. Each
 * file runs inside one transaction together with its `schema_migrations`
 * bookkeeping row, so a crash mid-file leaves nothing half-applied.
 *
 * Concurrency: the version row is inserted *first* inside the transaction.
 * Two gateway replicas booting at once both enter the transaction; the second
 * blocks on the primary-key conflict until the first commits, then sees the
 * conflict and skips. A cluster-wide leader lock (Redis `lock:leader:migrate`,
 * spec §4) plugs in via {@link LeaderLock}; until P5 lands the default is a
 * no-op and the row-level guard above is the only coordination.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "./client";

export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Seam for a cluster-wide leader lock around the whole migration run. */
export interface LeaderLock {
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const noopLeaderLock: LeaderLock = {
  withLock: (_name, fn) => fn(),
};

export type Migration = { version: string; name: string; sql: string };

const FILE_RE = /^(\d{4})_([a-z0-9_-]+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = f.match(FILE_RE);
    if (!m) continue;
    out.push({ version: m[1]!, name: m[2]!, sql: readFileSync(join(dir, f), "utf8") });
  }
  const seen = new Set<string>();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return out;
}

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function runMigrations(
  db: DbClient,
  opts: { migrations?: Migration[]; lock?: LeaderLock; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  if (db.dialect !== "pg") {
    // sqlite keeps its legacy bootstrap (src/db/drivers/sqlite.ts).
    return { applied: [], skipped: [] };
  }
  const migrations = opts.migrations ?? loadMigrations();
  const lock = opts.lock ?? noopLeaderLock;
  const log = opts.log ?? ((m) => console.log(`[db] ${m}`));

  return lock.withLock("migrate", async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      )
    `);
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const m of migrations) {
      const ran = await db.transaction(async (tx) => {
        const claim = await tx.run(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)
           ON CONFLICT (version) DO NOTHING`,
          [m.version, m.name, Date.now()],
        );
        if (claim.changes === 0) return false;
        await tx.exec(m.sql);
        return true;
      });
      if (ran) {
        result.applied.push(m.version);
        log(`migration ${m.version}_${m.name} applied`);
      } else {
        result.skipped.push(m.version);
      }
    }
    return result;
  });
}

/** Versions recorded in schema_migrations (empty on sqlite). */
export async function appliedVersions(db: DbClient): Promise<string[]> {
  if (db.dialect !== "pg") return [];
  const rows = await db.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`);
  return rows.map((r) => r.version);
}
