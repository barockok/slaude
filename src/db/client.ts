/**
 * DB driver seam.
 *
 * Every repository module (`src/db/*.ts`, `src/memory/sqlite-provider.ts`)
 * talks to this minimal interface instead of `bun:sqlite` directly, so the
 * same SQL runs on:
 *
 *   - sqlite  (`bun:sqlite`, the historical default)       SLAUDE_DB=sqlite
 *   - Postgres (`Bun.sql`)                                   SLAUDE_DB=pg + SLAUDE_PG_URL
 *   - PGLite  (in-process Postgres for sim / tests)          SLAUDE_DB=pg, no URL
 *
 * SQL is written once with `?` placeholders; the Postgres drivers rewrite
 * them to `$n`. Drivers return plain row objects with bigint columns
 * normalised to JS numbers so row shapes match across dialects.
 *
 * `db` is a lazy facade: the first call opens the connection (and, on
 * Postgres, applies pending migrations). Under sqlite every operation runs
 * synchronously and resolves an already-settled promise, which keeps the
 * historical "call and forget" behaviour of the sqlite repo layer intact.
 */
import { paths } from "../config/home";

export type Dialect = "sqlite" | "pg";
export type Row = Record<string, any>;
export type RunResult = { changes: number };

export interface DbClient {
  readonly dialect: Dialect;
  /** Concrete driver behind the client: bun-sqlite | bun-sql | pglite. */
  readonly driver: string;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Execute one or more statements with no parameters (DDL / migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /**
   * Postgres only: block until a session-level advisory lock (key1, key2) is
   * held on a dedicated connection; resolves to an unlock function. Undefined
   * on sqlite. Used to serialize replicas around DDL (migrations).
   */
  advisoryLock?(key1: number, key2: number): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export type DbConfig =
  | { dialect: "sqlite"; path: string }
  | { dialect: "pg"; driver: "bun-sql"; url: string }
  | { dialect: "pg"; driver: "pglite"; dataDir?: string };

/** Resolve the DB target from env. Default stays sqlite so existing deploys are unchanged. */
export function resolveDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const kind = (env.SLAUDE_DB ?? "sqlite").trim().toLowerCase();
  if (kind === "sqlite" || kind === "") return { dialect: "sqlite", path: paths.db };
  if (kind !== "pg" && kind !== "postgres" && kind !== "postgresql") {
    throw new Error(`SLAUDE_DB must be 'sqlite' or 'pg' (got '${kind}')`);
  }
  const url = env.SLAUDE_PG_URL?.trim();
  if (url) return { dialect: "pg", driver: "bun-sql", url };
  // No URL: sim + tests run an in-process Postgres. SLAUDE_PGLITE_DIR persists
  // it to disk; unset = in-memory (fresh on every boot).
  const dataDir = env.SLAUDE_PGLITE_DIR?.trim();
  return { dialect: "pg", driver: "pglite", dataDir: dataDir || undefined };
}

/**
 * Rewrite `?` placeholders to `$1..$n`.
 *
 * The scanner skips `?` inside single-quoted strings (`''` escapes included),
 * double-quoted identifiers, dollar-quoted strings (`$$..$$`, `$tag$..$tag$`),
 * line comments (`-- ..\n`) and block comments (multi-line safe; nesting not
 * supported). Constraint for repo SQL: a bare `?` outside those regions is
 * ALWAYS a placeholder, so the JSONB operators `?`, `?|`, `?&` must not be
 * used — write `jsonb_exists(col, key)` / `jsonb_exists_any` /
 * `jsonb_exists_all` instead.
 */
export function toPositional(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i]!;
    const next = i + 1 < len ? sql[i + 1] : "";
    if (c === "'") {
      // single-quoted string; '' is an escaped quote inside it
      out += c;
      i++;
      while (i < len) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      // double-quoted identifier; "" is an escaped quote inside it
      out += c;
      i++;
      while (i < len) {
        out += sql[i];
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      out += end === -1 ? sql.slice(i) : sql.slice(i, end);
      i = end === -1 ? len : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (c === "$") {
      // dollar-quoted string: $tag$ ... $tag$ (tag may be empty)
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const open = m[0];
        const close = sql.indexOf(open, i + open.length);
        const end = close === -1 ? len : close + open.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === "?") {
      n += 1;
      out += `$${n}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Normalise driver rows: bigint -> number so timestamps compare like sqlite's INTEGER. */
export function normalizeRow<T = Row>(row: Row): T {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "bigint") row[k] = Number(v);
  }
  return row as T;
}

/** Open a client for an explicit config (used by the facade and by migrate-sqlite). */
export async function openDb(cfg: DbConfig): Promise<DbClient> {
  if (cfg.dialect === "sqlite") {
    const { openSqlite } = await import("./drivers/sqlite");
    return openSqlite(cfg.path);
  }
  if (cfg.driver === "pglite") {
    const { openPglite } = await import("./drivers/pglite");
    return openPglite(cfg.dataDir);
  }
  const { openBunSql } = await import("./drivers/pg");
  return openBunSql(cfg.url);
}

// ---------------------------------------------------------------------------
// Lazy singleton facade
// ---------------------------------------------------------------------------

let activeConfig: DbConfig | null = null;
let activePromise: Promise<DbClient> | null = null;
let activeSync: DbClient | null = null; // sqlite only: opened synchronously

function config(): DbConfig {
  if (!activeConfig) activeConfig = resolveDbConfig();
  return activeConfig;
}

/** Dialect the process is configured for (readable before the connection opens). */
export function dbDialect(): Dialect {
  return config().dialect;
}

/** Open (once) and return the process-wide client. Postgres: migrations applied first. */
export function getDb(): Promise<DbClient> {
  if (activeSync) return Promise.resolve(activeSync);
  if (!activePromise) {
    const cfg = config();
    activePromise = (async () => {
      if (cfg.dialect === "sqlite") return openSqliteSync(cfg.path);
      const client = await openDb(cfg);
      const { runMigrations } = await import("./migrate");
      await runMigrations(client);
      return client;
    })();
    activePromise.catch(() => {
      activePromise = null; // allow a retry after a failed open
    });
  }
  return activePromise;
}

function openSqliteSync(path: string): DbClient {
  if (!activeSync) {
    // Static require: sqlite is the default and must open without an await.
    const { openSqlite } = require("./drivers/sqlite") as typeof import("./drivers/sqlite");
    activeSync = openSqlite(path);
  }
  return activeSync;
}

/**
 * Raw `bun:sqlite` handle when the process runs on sqlite, else null. Escape
 * hatch for the few synchronous hot paths (soul overrides cache) and for
 * sqlite-only maintenance helpers; repository code must use the facade.
 */
export function getSqliteRaw(): import("bun:sqlite").Database | null {
  const s = sync();
  return s ? (s as import("./drivers/sqlite").SqliteClient).raw : null;
}

function sync(): DbClient | null {
  const cfg = config();
  if (cfg.dialect !== "sqlite") return null;
  return openSqliteSync(cfg.path);
}

/**
 * Process-wide client facade. Safe to import at module top-level: nothing is
 * opened until the first call.
 */
export const db: DbClient = {
  get dialect() {
    return config().dialect;
  },
  get driver() {
    const cfg = config();
    return cfg.dialect === "sqlite" ? "bun-sqlite" : cfg.driver;
  },
  query(sql, params) {
    const s = sync();
    return s ? s.query(sql, params) : getDb().then((d) => d.query(sql, params));
  },
  one(sql, params) {
    const s = sync();
    return s ? s.one(sql, params) : getDb().then((d) => d.one(sql, params));
  },
  run(sql, params) {
    const s = sync();
    return s ? s.run(sql, params) : getDb().then((d) => d.run(sql, params));
  },
  exec(sql) {
    const s = sync();
    return s ? s.exec(sql) : getDb().then((d) => d.exec(sql));
  },
  transaction(fn) {
    const s = sync();
    return s ? s.transaction(fn) : getDb().then((d) => d.transaction(fn));
  },
  async close() {
    const s = activeSync;
    const p = activePromise;
    activeSync = null;
    activePromise = null;
    activeConfig = null;
    if (s) await s.close();
    else if (p) await (await p).close();
  },
};

/** Test hook: drop the singleton so the next call re-resolves config and reopens. */
export async function __resetDbForTests() {
  await db.close();
}
