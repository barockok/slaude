/**
 * Postgres driver on `Bun.sql` (built in, no npm dependency). Selected when
 * SLAUDE_DB=pg and SLAUDE_PG_URL is set. `sql.unsafe(text, params)` runs the
 * same `$n` SQL the PGLite driver runs, so the two stay behaviourally
 * identical; `sql.begin` reserves one pooled connection for a transaction.
 */
import { SQL } from "bun";
import { normalizeRow, toPositional, type DbClient, type Row, type RunResult } from "../client";

type Executor = Pick<SQL, "unsafe">;

class BunSqlClient implements DbClient {
  readonly dialect = "pg" as const;
  readonly driver = "bun-sql";
  constructor(
    private readonly ex: Executor,
    private readonly root: SQL,
    private readonly inTx: boolean,
  ) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = (await this.ex.unsafe(toPositional(sql), params as any[])) as Row[];
    return rows.map((row) => normalizeRow<T>(row));
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = (await this.ex.unsafe(toPositional(sql), params as any[])) as Row[] & { count?: number };
    return { changes: r.count ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    // `.simple()` allows multiple semicolon-separated statements (DDL).
    await this.ex.unsafe(sql).simple();
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this); // join the outer transaction
    return this.root.begin(async (tx) => fn(new BunSqlClient(tx, this.root, true))) as Promise<T>;
  }

  async advisoryLock(key1: number, key2: number): Promise<() => Promise<void>> {
    // Session-level advisory locks are tied to one connection, so reserve one
    // from the pool and keep it out of rotation until unlock.
    const reserved = await this.root.reserve();
    try {
      await reserved.unsafe(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
    } catch (e) {
      reserved.release();
      throw e;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await reserved.unsafe(`SELECT pg_advisory_unlock($1, $2)`, [key1, key2]);
      } finally {
        reserved.release();
      }
    };
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.root.close();
  }
}

export async function openBunSql(url: string): Promise<DbClient> {
  const sql = new SQL({ url, max: Number(process.env.SLAUDE_PG_POOL ?? 10) });
  // Fail fast on bad credentials / unreachable host instead of on first query.
  await sql.unsafe("SELECT 1");
  return new BunSqlClient(sql, sql, false);
}
