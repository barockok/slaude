/**
 * PGLite driver: in-process Postgres (WASM). Used by `bun sim` and the test
 * suite when SLAUDE_DB=pg and no SLAUDE_PG_URL is set. Same SQL and migrations
 * as the real Postgres driver.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { normalizeRow, toPositional, type DbClient, type Row, type RunResult } from "../client";

type Executor = Pick<PGlite, "query" | "exec"> | Transaction;

class PgliteClient implements DbClient {
  readonly dialect = "pg" as const;
  readonly driver = "pglite";
  constructor(
    private readonly ex: Executor,
    private readonly root: PGlite,
  ) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.ex.query<Row>(toPositional(sql), params as any[]);
    return r.rows.map((row) => normalizeRow<T>(row));
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = await this.ex.query(toPositional(sql), params as any[]);
    return { changes: r.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.ex.exec(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.ex !== this.root) {
      // Already inside a transaction: PGLite has no savepoint helper on the
      // Transaction handle, so nested calls simply join the outer transaction.
      return fn(this);
    }
    const out = await this.root.transaction(async (tx) => fn(new PgliteClient(tx, this.root)));
    return out as T;
  }

  async advisoryLock(key1: number, key2: number): Promise<() => Promise<void>> {
    // PGLite is a single in-process connection, so the lock is trivially held;
    // taken anyway so both pg drivers behave identically.
    await this.root.query(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.root.query(`SELECT pg_advisory_unlock($1, $2)`, [key1, key2]);
    };
  }

  async close(): Promise<void> {
    if (this.ex === this.root) await this.root.close();
  }
}

export async function openPglite(dataDir?: string): Promise<DbClient> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return new PgliteClient(pg, pg);
}
