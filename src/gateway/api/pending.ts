/**
 * GET /v1/pending/:id — long-poll (default 30s) for a pending-gate resolution
 * (spec §3 "Blocking tools"). 200 {status, payload, resolvedBy} once settled,
 * 204 on timeout (caller re-polls), 404 for unknown ids.
 *
 * Implementation: a 500ms poll loop against the PendingSource seam, plus an
 * optional `gate:<id>` wake (Redis pub/sub via the gate bus) that turns a
 * click on ANY replica into an instant re-check. The poll fallback stays —
 * a missed publish only costs one interval, never the decision.
 */
import type { PendingSource } from "./pending-source";
import { json, notFound } from "./http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PendingOptions {
  /** Long-poll window before giving 204. Default 30s. */
  timeoutMs?: number;
  /** Poll interval. Default 500ms. */
  pollMs?: number;
  /** Optional wake subscription (gate bus): cb fires when the gate settles
   *  anywhere; returns the unsubscribe fn. Absent → pure polling. */
  wake?: (id: string, cb: () => void) => Promise<() => Promise<void>>;
}

export async function handlePending(
  id: string,
  source: PendingSource,
  opts: PendingOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  // Arm the wake BEFORE the first read so a publish between read and sleep is
  // never lost. One subscription serves the whole request; each loop
  // iteration parks a fresh promise on it.
  let wakeResolve: (() => void) | null = null;
  let woke = false;
  let unsub: (() => Promise<void>) | undefined;
  if (opts.wake) {
    try {
      unsub = await opts.wake(id, () => {
        woke = true;
        wakeResolve?.();
        wakeResolve = null;
      });
    } catch {
      /* bus unavailable — polling covers it */
    }
  }

  try {
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
      if (woke) {
        // Publish arrived during the read above — re-check immediately.
        woke = false;
        continue;
      }
      await Promise.race([
        sleep(Math.min(pollMs, Math.max(1, deadline - Date.now()))),
        new Promise<void>((r) => {
          wakeResolve = r;
        }),
      ]);
      wakeResolve = null;
      woke = false;
    }
  } finally {
    void unsub?.().catch(() => {});
  }
}
