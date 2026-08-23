/**
 * MERGE SEAM — pending-gate source for `GET /v1/pending/:id`.
 *
 * The durable implementation lives in `src/db/pending-gates.ts` (built in the
 * P2 worktree, Postgres `pending_gates` table) with the API:
 *
 *   create(kind, sessionId, payload, expiresAt) / get(id) /
 *   resolve(id, status, resolvedBy) / sweepExpired()
 *
 * This module mirrors that exact interface behind a thin seam plus an
 * in-memory implementation so /v1/pending is testable before the merge. Once
 * P2 lands, swap `defaultPendingSource()` to return an adapter over
 * `src/db/pending-gates.ts` (a one-line change) and keep the in-memory impl
 * for unit tests.
 */

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

/** P2 merge point: replace with an adapter over src/db/pending-gates.ts. */
export function defaultPendingSource(): PendingSource {
  return new InMemoryPendingSource();
}
