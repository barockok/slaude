import { db, dbDialect } from "./schema";

/**
 * Durable audit trail (migration 0032). Append-only at the code level: insert
 * and the retention purge are the only write paths, so there is no update and
 * no other delete. Callers go through src/audit (id, time, redaction).
 *
 * tenant_id exists on Postgres only (the sqlite bootstrap carries no tenant
 * columns, see tests/db/schema-drift.test.ts), so the tenant is written and
 * filtered on Postgres and ignored on sqlite.
 */
export interface AuditEvent {
  /** Time sortable: zero-padded epoch ms + random suffix. Also the list cursor. */
  id: string;
  tenantId?: string;
  persona?: string | null;
  /** Epoch ms. */
  at: number;
  actorKind: string;
  actorId: string;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  decision?: string | null;
  sessionId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  summary: string;
  details: Record<string, unknown>;
}

export interface AuditFilter {
  tenantId?: string;
  persona?: string;
  /** Exact action, or a prefix when it ends in "." (e.g. "gate."). */
  action?: string;
  actorId?: string;
  sessionId?: string;
  /** Inclusive epoch ms bounds. */
  since?: number;
  until?: number;
}

export interface AuditPage {
  items: AuditEvent[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export async function insert(ev: AuditEvent): Promise<void> {
  const cols = [
    "id", "persona", "at", "actor_kind", "actor_id", "action", "target_kind", "target_id",
    "decision", "session_id", "channel_id", "thread_ts", "summary", "details",
  ];
  const params: unknown[] = [
    ev.id, ev.persona ?? null, ev.at, ev.actorKind, ev.actorId, ev.action, ev.targetKind ?? null,
    ev.targetId ?? null, ev.decision ?? null, ev.sessionId ?? null, ev.channelId ?? null,
    ev.threadTs ?? null, ev.summary, JSON.stringify(ev.details ?? {}),
  ];
  if (dbDialect() === "pg" && ev.tenantId) {
    cols.push("tenant_id");
    params.push(ev.tenantId);
  }
  await db.run(
    `INSERT INTO audit_events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    params,
  );
}

/** Newest first, keyed on the time-sortable id. */
export async function list(filter: AuditFilter, opts: { cursor?: string; limit?: number } = {}): Promise<AuditPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.tenantId && dbDialect() === "pg") {
    where.push("tenant_id = ?");
    params.push(filter.tenantId);
  }
  if (filter.persona !== undefined) {
    where.push("persona = ?");
    params.push(filter.persona);
  }
  if (filter.action !== undefined) {
    if (filter.action.endsWith(".")) {
      // substr, not LIKE: action names contain "_", a LIKE wildcard.
      where.push("substr(action, 1, ?) = ?");
      params.push(filter.action.length, filter.action);
    } else {
      where.push("action = ?");
      params.push(filter.action);
    }
  }
  if (filter.actorId !== undefined) {
    where.push("actor_id = ?");
    params.push(filter.actorId);
  }
  if (filter.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.since !== undefined) {
    where.push("at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("at <= ?");
    params.push(filter.until);
  }
  if (opts.cursor) {
    where.push("id < ?");
    params.push(opts.cursor);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const rows = await db.query<Row>(
    `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(mapRow);
  return { items, nextCursor: more ? items[items.length - 1]!.id : null };
}

/** Retention: delete rows older than `maxAgeMs`. The only delete path. */
export async function purgeOlderThan(maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const r = await db.run(`DELETE FROM audit_events WHERE at < ?`, [now - maxAgeMs]);
  return r.changes;
}

type Row = {
  id: string;
  tenant_id?: string;
  persona: string | null;
  at: number | string;
  actor_kind: string;
  actor_id: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  decision: string | null;
  session_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  summary: string;
  details: unknown;
};

function mapRow(r: Row): AuditEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id ?? "default",
    persona: r.persona,
    at: Number(r.at),
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    decision: r.decision,
    sessionId: r.session_id,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    summary: r.summary,
    details: parseDetails(r.details),
  };
}

function parseDetails(v: unknown): Record<string, unknown> {
  // sqlite stores TEXT; the Postgres drivers hand JSONB back already parsed.
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return (v as Record<string, unknown>) ?? {};
}
