#!/usr/bin/env bun
/**
 * One-shot exporter: copy an existing sqlite db into Postgres.
 *
 *   bun run migrate-sqlite [--from <db.sqlite>] [--to <postgres-url>] [--dry-run]
 *
 * Source defaults to $SLAUDE_DB_PATH / $SLAUDE_HOME/db.sqlite; target to
 * $SLAUDE_PG_URL (or, with no URL, a PGLite directory from $SLAUDE_PGLITE_DIR).
 * Target migrations are applied first. Rows are inserted with ON CONFLICT DO
 * NOTHING, so the command is idempotent and safe to re-run after a partial
 * copy. Only columns present on both sides are copied; pg-only columns
 * (tenant_id) take their defaults. skill_usage is intentionally not copied.
 */
import { openDb, resolveDbConfig, type DbClient, type DbConfig } from "../db/client";
import { runMigrations } from "../db/migrate";
import { paths } from "../config/home";

/** Copy order matters only for readability; there are no FKs between these. */
export const EXPORT_TABLES = [
  "sessions",
  "ignores",
  "cron_jobs",
  "one_on_one_locks",
  "mention_only_threads",
  "soul_overrides",
  "kb_ingest_jobs",
  "memory_turns",
  "memory_facts",
] as const;

export type TableReport = { table: string; source: number; inserted: number; skipped: number };
export type ExportReport = { tables: TableReport[]; dryRun: boolean };

const BATCH = 500;

async function sourceColumns(src: DbClient, table: string): Promise<string[]> {
  const cols = await src.query<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

async function targetColumns(dst: DbClient, table: string): Promise<string[]> {
  const cols = await dst.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position`,
    [table],
  );
  return cols.map((c) => c.column_name);
}

export async function exportSqliteToPg(
  src: DbClient,
  dst: DbClient,
  opts: { dryRun?: boolean; log?: (m: string) => void } = {},
): Promise<ExportReport> {
  if (src.dialect !== "sqlite") throw new Error("source must be sqlite");
  if (dst.dialect !== "pg") throw new Error("target must be Postgres");
  const log = opts.log ?? ((m) => console.log(m));
  const dryRun = !!opts.dryRun;

  await runMigrations(dst, { log: (m) => log(`[target] ${m}`) });

  const report: ExportReport = { tables: [], dryRun };
  for (const table of EXPORT_TABLES) {
    const srcCols = await sourceColumns(src, table);
    if (srcCols.length === 0) {
      log(`[skip] ${table}: not present in source`);
      continue;
    }
    const dstCols = new Set(await targetColumns(dst, table));
    const cols = srcCols.filter((c) => dstCols.has(c));
    const total = (await src.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
    const rep: TableReport = { table, source: total, inserted: 0, skipped: 0 };
    report.tables.push(rep);
    if (dryRun) {
      log(`[dry-run] ${table}: ${total} row(s), columns: ${cols.join(", ")}`);
      continue;
    }

    const placeholders = `(${cols.map(() => "?").join(", ")})`;
    const insertSql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;
    for (let offset = 0; offset < total; offset += BATCH) {
      const rows = await src.query<Record<string, unknown>>(
        `SELECT ${cols.join(", ")} FROM ${table} LIMIT ? OFFSET ?`,
        [BATCH, offset],
      );
      await dst.transaction(async (tx) => {
        for (const row of rows) {
          const r = await tx.run(insertSql, cols.map((c) => row[c] ?? null));
          if (r.changes > 0) rep.inserted += 1;
          else rep.skipped += 1;
        }
      });
    }
    // BIGSERIAL tables: move the sequence past the copied ids.
    if (cols.includes("id") && (table === "memory_turns" || table === "memory_facts")) {
      await dst.run(
        `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`,
        [table],
      );
    }
    log(`[copy] ${table}: ${rep.inserted} inserted, ${rep.skipped} already present (source ${total})`);
  }
  return report;
}

function parseArgs(argv: string[]) {
  const out: { from?: string; to?: string; dryRun: boolean; help: boolean } = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: bun run migrate-sqlite [--from <db.sqlite>] [--to <postgres-url>] [--dry-run]");
    return 0;
  }
  const sourcePath = args.from ?? paths.db;
  const targetCfg = resolveDbConfig({
    SLAUDE_DB: "pg",
    SLAUDE_PG_URL: args.to ?? process.env.SLAUDE_PG_URL,
    SLAUDE_PGLITE_DIR: process.env.SLAUDE_PGLITE_DIR,
  }) as Extract<DbConfig, { dialect: "pg" }>;
  if (targetCfg.driver === "pglite" && !targetCfg.dataDir) {
    console.error("no target: set SLAUDE_PG_URL (or --to <url>), or SLAUDE_PGLITE_DIR for a PGLite target");
    return 2;
  }
  console.log(`[migrate-sqlite] source ${sourcePath} -> ${targetCfg.driver === "bun-sql" ? "postgres" : `pglite:${targetCfg.dataDir}`}${args.dryRun ? " (dry-run)" : ""}`);

  const src = await openDb({ dialect: "sqlite", path: sourcePath });
  const dst = await openDb(targetCfg);
  try {
    const report = await exportSqliteToPg(src, dst, { dryRun: args.dryRun });
    const inserted = report.tables.reduce((n, t) => n + t.inserted, 0);
    console.log(`[migrate-sqlite] done: ${inserted} row(s) inserted across ${report.tables.length} table(s)`);
    return 0;
  } finally {
    await src.close();
    await dst.close();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("[migrate-sqlite] failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
