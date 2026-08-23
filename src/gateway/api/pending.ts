/**
 * GET /v1/pending/:id — long-poll (default 30s) for a pending-gate resolution
 * (spec §3 "Blocking tools"). 200 {status, payload, resolvedBy} once settled,
 * 204 on timeout (caller re-polls), 404 for unknown ids.
 *
 * Implementation: a 500ms poll loop against the PendingSource seam. The
 * Redis `gate:<id>` pub/sub wake-up is a later optimization (P5+); polling is
 * within spec and keeps this endpoint dependency-free.
 */
import type { PendingSource } from "./pending-source";
import { json, notFound } from "./http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PendingOptions {
  /** Long-poll window before giving 204. Default 30s. */
  timeoutMs?: number;
  /** Poll interval. Default 500ms. */
  pollMs?: number;
}

export async function handlePending(
  id: string,
  source: PendingSource,
  opts: PendingOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const row = await source.get(id);
    if (!row) return notFound("unknown pending id");
    if (row.status !== "pending") {
      return json(200, { status: row.status, payload: row.payload, resolvedBy: row.resolvedBy });
    }
    if (row.expiresAt <= Date.now()) {
      // Report expiry immediately instead of long-polling a gate that can
      // never resolve; the sweeper will persist the status.
      return json(200, { status: "expired", payload: row.payload, resolvedBy: null });
    }
    if (Date.now() >= deadline) return new Response(null, { status: 204 });
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
