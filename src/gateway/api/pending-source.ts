/**
 * Pending-gate source for `GET /v1/pending/:id`.
 *
 * `defaultPendingSource()` adapts the durable `pending_gates` repo
 * (src/db/pending-gates.ts) — the same rows the gateway's permission /
 * approval / mcp_connect gates persist — so a long-poll on /v1/pending sees
 * a Block Kit click or expiry from ANY replica. `InMemoryPendingSource`
 * remains for unit tests that don't want a DB.
 */
import * as PendingGates from "../../db/pending-gates";

export type PendingGateKind = "perm" | "approval" | "mcp_connect";

export interface PendingGateRow {
  id: string;
  sessionId: string;
  kind: PendingGateKind;
  payload: unknown;
  /** 'pending' until resolved; resolution statuses are defined by the gate kind
   *  (e.g. 'approved' | 'denied'), plus 'expired' from the sweeper. */
  status: string;
  resolvedBy: string | null;
  resolvedAt: number | null;
  expiresAt: number;
}

export interface PendingSource {
  create(kind: PendingGateKind, sessionId: string, payload: unknown, expiresAt: number): Promise<PendingGateRow>;
  get(id: string): Promise<PendingGateRow | null>;
  resolve(id: string, status: string, resolvedBy: string): Promise<PendingGateRow | null>;
  /** Mark expired pending rows; returns how many were swept. */
  sweepExpired(): Promise<number>;
}

export class InMemoryPendingSource implements PendingSource {
  #rows = new Map<string, PendingGateRow>();

  async create(kind: PendingGateKind, sessionId: string, payload: unknown, expiresAt: number): Promise<PendingGateRow> {
    const row: PendingGateRow = {
      id: crypto.randomUUID(),
      sessionId,
      kind,
      payload,
      status: "pending",
      resolvedBy: null,
      resolvedAt: null,
      expiresAt,
    };
    this.#rows.set(row.id, row);
    return row;
  }

  async get(id: string): Promise<PendingGateRow | null> {
    return this.#rows.get(id) ?? null;
  }

  async resolve(id: string, status: string, resolvedBy: string): Promise<PendingGateRow | null> {
    const row = this.#rows.get(id);
    if (!row || row.status !== "pending") return null;
    row.status = status;
    row.resolvedBy = resolvedBy;
    row.resolvedAt = Date.now();
    return row;
  }

  async sweepExpired(): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const row of this.#rows.values()) {
      if (row.status === "pending" && row.expiresAt <= now) {
        row.status = "expired";
        n++;
      }
    }
    return n;
  }
}

/**
 * Adapter over the durable pending_gates repo. Shape notes:
 * - the repo's `expiresAt` is nullable (never-expiring gates, e.g. mcp_connect
 *   cards before the TTL); the seam's row is non-null, so null maps to
 *   Infinity — `handlePending`'s `expiresAt <= now` check then never trips.
 * - `resolve` statuses are constrained by the pending_gates CHECK
 *   (approved | denied | expired | cancelled); anything else rejects at the DB.
 */
export class DbPendingSource implements PendingSource {
  async create(kind: PendingGateKind, sessionId: string, payload: unknown, expiresAt: number): Promise<PendingGateRow> {
    const row = await PendingGates.create({
      kind,
      sessionId,
      payload: (payload ?? {}) as Record<string, unknown>,
      expiresAt,
    });
    return toSeamRow(row);
  }

  async get(id: string): Promise<PendingGateRow | null> {
    const row = await PendingGates.get(id);
    return row ? toSeamRow(row) : null;
  }

  async resolve(id: string, status: string, resolvedBy: string): Promise<PendingGateRow | null> {
    if (status === "pending") return null;
    const row = await PendingGates.resolve(id, status as Exclude<PendingGates.GateStatus, "pending">, resolvedBy);
    return row ? toSeamRow(row) : null;
  }

  async sweepExpired(): Promise<number> {
    return (await PendingGates.sweepExpired()).length;
  }
}

function toSeamRow(row: PendingGates.PendingGate): PendingGateRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt ?? Infinity,
  };
}

/** Durable by default: /v1/pending long-polls the shared pending_gates table. */
export function defaultPendingSource(): PendingSource {
  return new DbPendingSource();
}
