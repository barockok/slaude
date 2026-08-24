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

  async advisoryLock(
    key1: number,
    key2: number,
    opts: { onWait?: () => void; timeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    // PGLite is a single in-process connection: advisory locks are re-entrant
    // per session, so the try always succeeds; taken anyway so both pg
    // drivers behave identically.
    const fast = await this.root.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1, $2) AS ok`, [key1, key2]);
    if (!fast.rows[0]?.ok) {
      opts.onWait?.();
      await this.root.query(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
    }
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

// PGLite instantiation is the fragile step: a fresh database boots an INNER
// second wasm instance just to run initdb, so every open briefly doubles the
// wasm footprint. Under instance churn (test suites, facade resets) an initdb
// crash ("terminated by signal 1") corrupts shared module state and poisons
// every later PGLite open in the process. Contain it: collect dead instances
// before each open, never overlap two instantiations, and retry once.
let openChain: Promise<unknown> = Promise.resolve();

const gc = () => (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);

export async function openPglite(dataDir?: string): Promise<DbClient> {
  const mk = async () => {
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    return pg;
  };
  const run = openChain.then(
    async () => {
      gc();
      let lastErr: unknown;
      // A single immediate retry is not always enough under memory pressure:
      // initdb's inner wasm instance can keep crashing until dead instances
      // are actually collected. Back off briefly between attempts so GC gets
      // a quiet tick, and try a few times before giving up.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          gc();
        }
        try {
          return await mk();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
  );
  openChain = run.catch(() => {});
  const pg = await run;
  return new PgliteClient(pg, pg);
}
