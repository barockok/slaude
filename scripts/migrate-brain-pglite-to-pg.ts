#!/usr/bin/env bun
/**
 * Migrate gbrain data from a PGLite brain (file-based) to a shared Postgres
 * instance. Run this BEFORE switching SLAUDE_BRAIN_ENGINE=postgres.
 *
 * Usage:
 *   SLAUDE_BRAIN_DATABASE_URL=postgresql://... bun run scripts/migrate-brain-pglite-to-pg.ts [options]
 *
 * Options:
 *   --dry-run              Show row counts, skip all writes to Postgres.
 *   --pglite-db <path>     PGLite db dir (overrides SLAUDE_BRAIN_HOME derivation).
 *   --snap-dir <path>      Where to write the working snapshot (default: /tmp/slaude-brain-migrate-<pid>).
 *   --keep-snap            Don't delete the snapshot after migration (useful for debugging).
 *
 * Env (all optional except SLAUDE_BRAIN_DATABASE_URL):
 *   SLAUDE_BRAIN_HOME        Brain home dir (default: ~/.slaude/brain); db/ subdir is used as source.
 *   SLAUDE_BRAIN_PGLITE_DB   PGLite db dir (same as --pglite-db; flag takes precedence).
 *   SLAUDE_BRAIN_SNAP_DIR    Snapshot dir (same as --snap-dir; flag takes precedence).
 *   SLAUDE_BRAIN_DATABASE_URL Target Postgres URL (required).
 *
 * The running agent MUST be stopped before running this script — PGLite is
 * single-writer and will timeout if the lock is held. The script snapshots
 * the PGLite db dir so it never touches the live data.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "dry-run":   { type: "boolean", default: false },
    "pglite-db": { type: "string" },
    "snap-dir":  { type: "string" },
    "keep-snap": { type: "boolean", default: false },
  },
  strict: true,
});
const DRY_RUN   = flags["dry-run"]   as boolean;
const KEEP_SNAP = flags["keep-snap"] as boolean;

const BRAIN_HOME = process.env.SLAUDE_BRAIN_HOME ?? join(homedir(), ".slaude", "brain");
const PG_URL = process.env.SLAUDE_BRAIN_DATABASE_URL;

if (!PG_URL) {
  console.error("error: SLAUDE_BRAIN_DATABASE_URL is required");
  process.exit(1);
}

const PGLITE_DB =
  (flags["pglite-db"] as string | undefined) ??
  process.env.SLAUDE_BRAIN_PGLITE_DB ??
  join(BRAIN_HOME, "db");

if (!existsSync(PGLITE_DB)) {
  console.error(`error: PGLite db dir not found at ${PGLITE_DB}`);
  console.error("  set --pglite-db <path> or SLAUDE_BRAIN_PGLITE_DB to override");
  process.exit(1);
}

// Tables to migrate in FK-safe order. Ephemeral/auth/log tables are excluded.
// gbrain seeds `sources` with a default row — we skip it to avoid conflicts.
const TABLES = [
  "sources",
  "config",
  "files",
  "pages",
  "page_generation_clock",
  "content_chunks",
  "code_edges_chunk",
  "code_edges_symbol",
  "links",
  "tags",
  "raw_data",
  "timeline_entries",
  "page_versions",
  "ingest_log",
  "op_checkpoints",
  "op_checkpoint_paths",
  "minion_jobs",
  "minion_inbox",
  "minion_attachments",
  "migration_impact_log",
  "dream_verdicts",
];

// Tables whose serial/sequence primary key must be reset in Postgres after insert
// so the next INSERT doesn't collide.
const TABLES_WITH_SERIAL = new Set([
  "pages",
  "content_chunks",
  "code_edges_chunk",
  "code_edges_symbol",
  "links",
  "tags",
  "raw_data",
  "timeline_entries",
  "page_versions",
  "ingest_log",
  "op_checkpoints",
  "files",
  "minion_jobs",
  "minion_inbox",
  "minion_attachments",
  "migration_impact_log",
  "dream_verdicts",
]);

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

// gbrainImport matches brain.ts: skips tsc, resolves at runtime via Bun.
const gbrainImport = (sub: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + sub) as string) as Promise<Record<string, unknown>>;

type DbEngine = {
  connect(c: object): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
};

async function openEngine(cfg: object): Promise<DbEngine> {
  const { createEngine } = (await gbrainImport("engine-factory")) as {
    createEngine: (c: object) => Promise<DbEngine>;
  };
  const engine = (await createEngine(cfg)) as DbEngine;
  await engine.connect(cfg);
  await engine.initSchema();
  return engine;
}

async function tableExists(engine: DbEngine, table: string): Promise<boolean> {
  const res = await engine.db!.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.length > 0;
}

async function getColumns(engine: DbEngine, table: string): Promise<string[]> {
  const res = await engine.db!.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return res.rows.map((r) => r.column_name as string);
}

async function migrateTable(src: DbEngine, dst: DbEngine, table: string): Promise<void> {
  if (!(await tableExists(src, table))) {
    log(`  skip ${table} (not in source)`);
    return;
  }
  if (!(await tableExists(dst, table))) {
    log(`  skip ${table} (not in target — schema mismatch?)`);
    return;
  }

  // Only copy columns present in both engines (schema may have gained columns).
  const srcCols = await getColumns(src, table);
  const dstCols = new Set(await getColumns(dst, table));
  const cols = srcCols.filter((c) => dstCols.has(c));
  if (!cols.length) {
    log(`  skip ${table} (no common columns)`);
    return;
  }

  const countRes = await src.db!.query(`SELECT count(*)::int AS n FROM "${table}"`);
  const total = (countRes.rows[0]?.n as number) ?? 0;
  if (total === 0) {
    log(`  ${table}: 0 rows, skip`);
    return;
  }

  log(`  ${table}: ${total} rows → ${DRY_RUN ? "(dry-run, skip write)" : "inserting..."}`);
  if (DRY_RUN) return;

  // Fetch all rows. For very large tables (>50k) this could be chunked, but
  // brain data is typically small (thousands of pages at most).
  const BATCH = 500;
  let offset = 0;
  let inserted = 0;

  const colList = cols.map((c) => `"${c}"`).join(", ");

  while (offset < total) {
    const res = await src.db!.query(`SELECT ${colList} FROM "${table}" ORDER BY 1 LIMIT ${BATCH} OFFSET ${offset}`);
    if (!res.rows.length) break;

    for (const row of res.rows) {
      const vals = cols.map((c) => row[c]);
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
      try {
        await dst.db!.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          vals,
        );
        inserted++;
      } catch (e) {
        // Log but don't abort — some rows may fail due to column type differences.
        const msg = e instanceof Error ? e.message : String(e);
        log(`    warn: row insert failed for ${table}: ${msg.slice(0, 120)}`);
      }
    }
    offset += BATCH;
  }
  log(`  ${table}: inserted ${inserted}/${total}`);
}

async function resetSequence(engine: DbEngine, table: string): Promise<void> {
  // Reset the serial sequence to max(id)+1 so future inserts don't collide.
  try {
    await engine.db!.query(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`,
    );
  } catch {
    // Table may not have an 'id' serial — ignore.
  }
}

async function main() {
  log(`PGLite source : ${PGLITE_DB}`);
  log(`Postgres target: ${PG_URL!.replace(/:[^:@]+@/, ":***@")}`);
  if (DRY_RUN) log("DRY RUN — no writes to Postgres");

  // Snapshot PGLite db dir so we open a copy, not the live one.
  const snap =
    (flags["snap-dir"] as string | undefined) ??
    process.env.SLAUDE_BRAIN_SNAP_DIR ??
    `/tmp/slaude-brain-migrate-${process.pid}`;
  log(`snapshotting PGLite → ${snap}`);
  if (existsSync(snap)) rmSync(snap, { recursive: true });
  cpSync(PGLITE_DB, snap, { recursive: true });
  // Remove any leftover lock artifacts in the snapshot so PGLite opens cleanly.
  for (const f of [".gbrain-lock", "lock"]) {
    const p = join(snap, f);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  process.env.GBRAIN_HOME = BRAIN_HOME;

  log("connecting to PGLite (snapshot)...");
  const srcCfg = { engine: "pglite", database_path: snap };
  const src = await openEngine(srcCfg);
  log("PGLite connected");

  log("connecting to Postgres...");
  const dstCfg = { engine: "postgres", database_url: PG_URL };
  const dst = await openEngine(dstCfg);
  log("Postgres connected + schema initialised");

  log(`migrating ${TABLES.length} tables...`);
  for (const table of TABLES) {
    await migrateTable(src, dst, table);
    if (!DRY_RUN && TABLES_WITH_SERIAL.has(table)) {
      await resetSequence(dst, table);
    }
  }

  log("disconnecting...");
  await src.disconnect();
  await dst.disconnect();

  if (KEEP_SNAP) {
    log(`keeping snapshot at ${snap} (--keep-snap)`);
  } else {
    log("cleaning up snapshot...");
    rmSync(snap, { recursive: true, force: true });
  }

  log(DRY_RUN ? "dry-run complete — no data written" : "migration complete");
  if (!DRY_RUN) {
    log("");
    log("next steps:");
    log("  1. verify: SLAUDE_BRAIN_ENGINE=postgres SLAUDE_BRAIN_DATABASE_URL=<url> bun run src/server.ts");
    log("  2. if happy, update your deployment env and restart");
    log("  3. keep the PGLite db dir as a backup until you're confident");
  }
}

main().catch((e) => {
  console.error("[migrate] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
