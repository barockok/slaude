/**
 * Postgres driver on `Bun.sql` (built in, no npm dependency). Selected when
 * SLAUDE_DB=pg and SLAUDE_PG_URL is set. `sql.unsafe(text, params)` runs the
 * same `$n` SQL the PGLite driver runs, so the two stay behaviourally
 * identical; `sql.begin` reserves one pooled connection for a transaction.
 */
import { SQL } from "bun";
import { env } from "../../config/env";
import { m } from "../../metrics";
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

/**
 * Admission gate in front of the Bun.sql pool: at most `size` statements (or reserved
 * connections: a transaction, an advisory lock) are handed to the pool at once, the rest
 * wait here in order.
 *
 * Why: this is a WORKAROUND for a likely Bun.sql bug. Past the pool size Bun does not queue
 * a statement, its PostgresAdapter (flushConcurrentQueries) auto-pipelines the excess onto
 * connections that are already busy. On real Postgres a burst of identical statements beyond
 * the pool size wedged the whole pool: every backend idle, one backend stuck "idle in
 * transaction" between a Parse and its Sync, no promise ever settling, CI hung for 20
 * minutes (watchdog dump in PR 213). That fits auto-pipelining of a statement that is still
 * being prepared, but the Bun internals were not read to the end. The gate keeps the work in
 * flight at or below the connection count, so Bun never has anything to pipeline.
 *
 * Untested alternatives, for a follow-up: set BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1
 * in the environment, or open the pool with `prepare: false`. Either would need the same
 * real-Postgres soak before replacing the gate (`prepare: false` also changes how parameter
 * types are inferred, so it can break queries).
 *
 * Observability: `slaude_pg_gate_waiting` (gauge), a warning and `slaude_pg_gate_slow_total`
 * when a statement waits more than 3 s for a permit, and an optional acquire timeout
 * (SLAUDE_PG_ACQUIRE_TIMEOUT_MS, default off).
 */
export const GATE_SLOW_MS = 3000;
const GATE_WARN_EVERY_MS = 5000;

type Waiter = { grant: () => void; fail: (e: Error) => void; slow?: ReturnType<typeof setTimeout>; limit?: ReturnType<typeof setTimeout> };

export interface PoolGateOptions {
  /** Fail a wait after this many ms (default 0: never). */
  acquireTimeoutMs?: number;
  /** A wait longer than this counts and warns (default GATE_SLOW_MS). */
  slowMs?: number;
  warn?: (msg: string) => void;
  onWaiting?: (n: number) => void;
  onEvent?: (outcome: "slow" | "timeout") => void;
}

export class PoolGate {
  #free: number;
  #waiters: Waiter[] = [];
  #lastWarn = 0;
  constructor(
    readonly size: number,
    private readonly opts: PoolGateOptions = {},
  ) {
    this.#free = size;
  }
  /** Callers waiting for a permit right now. */
  get waiting(): number {
    return this.#waiters.length;
  }
  acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { grant: resolve, fail: reject };
      const slowMs = this.opts.slowMs ?? GATE_SLOW_MS;
      w.slow = setTimeout(() => {
        this.opts.onEvent?.("slow");
        const now = Date.now();
        if (now - this.#lastWarn >= GATE_WARN_EVERY_MS) {
          this.#lastWarn = now;
          (this.opts.warn ?? console.warn)(`[db] statements are waiting more than ${slowMs}ms for a Postgres pool permit (pool ${this.size}, waiting ${this.#waiters.length}): the pool is saturated or wedged`);
        }
      }, slowMs);
      const limit = this.opts.acquireTimeoutMs ?? 0;
      if (limit > 0) {
        w.limit = setTimeout(() => {
          const at = this.#waiters.indexOf(w);
          if (at < 0) return;
          this.#waiters.splice(at, 1);
          clearTimeout(w.slow);
          this.opts.onEvent?.("timeout");
          this.opts.onWaiting?.(this.#waiters.length);
          reject(new Error(`postgres pool gate: waited ${limit}ms for a connection permit (pool ${this.size}, waiting ${this.#waiters.length})`));
        }, limit);
      }
      this.#waiters.push(w);
      this.opts.onWaiting?.(this.#waiters.length);
    });
  }
  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      clearTimeout(next.slow);
      clearTimeout(next.limit);
      this.opts.onWaiting?.(this.#waiters.length);
      next.grant();
    } else this.#free++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class BunSqlClient implements DbClient {
  readonly dialect = "pg" as const;
  readonly driver = "bun-sql";
  constructor(
    private readonly ex: Executor,
    private readonly root: SQL,
    private readonly inTx: boolean,
    private readonly gate?: PoolGate,
  ) {}

  /** Statements on the shared pool pass the gate; statements inside a transaction already hold their connection. */
  private gated<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate && !this.inTx ? this.gate.run(fn) : fn();
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = (await this.gated(() => this.ex.unsafe(toPositional(sql), params as any[]) as Promise<Row[]>)) as Row[];
    return rows.map((row) => normalizeRow<T>(row));
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = (await this.gated(() => this.ex.unsafe(toPositional(sql), params as any[]) as Promise<Row[] & { count?: number }>)) as Row[] & { count?: number };
    return { changes: r.count ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    // `.simple()` allows multiple semicolon-separated statements (DDL).
    await this.gated(async () => void (await this.ex.unsafe(sql).simple()));
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this); // join the outer transaction
    return this.gated(() => this.root.begin(async (tx) => fn(new BunSqlClient(tx, this.root, true))) as Promise<T>);
  }

  async advisoryLock(
    key1: number,
    key2: number,
    opts: { onWait?: () => void; timeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    // Session-level advisory locks are tied to one connection, so reserve one
    // from the pool and keep it out of rotation until unlock.
    // The reserved connection holds a gate permit until unlock.
    await this.gate?.acquire();
    let reserved: Awaited<ReturnType<SQL["reserve"]>>;
    try {
      reserved = await this.root.reserve();
    } catch (e) {
      this.gate?.release();
      throw e;
    }
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
            // The connection goes back to the pool: it must not carry this timeout into someone else's statement.
            await reserved.unsafe(`SET lock_timeout = 0`).catch(() => {});
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`advisory lock (${key1}, ${key2}) not acquired within ${timeoutMs}ms: ${msg}`);
          }
          await reserved.unsafe(`SET lock_timeout = 0`);
        } else {
          await reserved.unsafe(`SELECT pg_advisory_lock($1, $2)`, [key1, key2]);
        }
      }
    } catch (e) {
      try {
        reserved.release();
      } finally {
        this.gate?.release();
      }
      throw e;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await reserved.unsafe(`SELECT pg_advisory_unlock($1, $2)`, [key1, key2]);
      } finally {
        try {
          reserved.release();
        } finally {
          this.gate?.release();
        }
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
  return new BunSqlClient(
    sql,
    sql,
    false,
    new PoolGate(env.db.pgPool(), {
      acquireTimeoutMs: env.db.pgAcquireTimeoutMs(),
      onWaiting: (n) => m.pgGateWaiting.set(n),
      onEvent: (outcome) => m.pgGateSlowTotal.inc({ outcome }),
    }),
  );
}
