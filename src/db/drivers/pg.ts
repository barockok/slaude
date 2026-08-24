/**
 * Postgres driver on `Bun.sql` (built in, no npm dependency). Selected when
 * SLAUDE_DB=pg and SLAUDE_PG_URL is set. `sql.unsafe(text, params)` runs the
 * same `$n` SQL the PGLite driver runs, so the two stay behaviourally
 * identical; `sql.begin` reserves one pooled connection for a transaction.
 */
import { SQL } from "bun";
import { env } from "../../config/env";
import { normalizeRow, toPositional, type DbClient, type Row, type RunResult } from "../client";

/** URL with any password replaced, safe for error messages and logs. */
export function redactPgUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

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

  async advisoryLock(
    key1: number,
    key2: number,
    opts: { onWait?: () => void; timeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    // Session-level advisory locks are tied to one connection, so reserve one
    // from the pool and keep it out of rotation until unlock.
    const reserved = await this.root.reserve();
    try {
      const fast = (await reserved.unsafe(`SELECT pg_try_advisory_lock($1, $2) AS ok`, [key1, key2])) as Array<{ ok: boolean }>;
      if (!fast[0]?.ok) {
        // Contended: say so before blocking, so a held lock never looks like a hang.
        opts.onWait?.();
        const timeoutMs = Math.floor(opts.timeoutMs ?? 0);
        if (timeoutMs > 0) {
          // lock_timeout applies to advisory-lock waits; scoped to this
          // reserved connection, reset once acquired.
          await reserved.unsafe(`SET lock_timeout = ${timeoutMs}`);
          try {
            await reserved.unsafe(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`advisory lock (${key1}, ${key2}) not acquired within ${timeoutMs}ms: ${msg}`);
          }
          await reserved.unsafe(`SET lock_timeout = 0`);
        } else {
          await reserved.unsafe(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
        }
      }
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
  // bigint: true makes int8 columns come back as BigInt (instead of strings),
  // which normalizeRow folds to JS numbers — matching PGLite and sqlite row
  // shapes. Timestamps are ms-since-epoch, far below 2^53.
  const sql = new SQL({ url, max: env.db.pgPool(), bigint: true });
  try {
    // Fail fast on bad credentials / unreachable host instead of on first query.
    await sql.unsafe("SELECT 1");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot connect to Postgres at SLAUDE_PG_URL=${redactPgUrl(url)}: ${msg}`);
  }
  return new BunSqlClient(sql, sql, false);
}
