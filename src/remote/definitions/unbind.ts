/**
 * The rollback step for rc.23: a thread bound to a shared environment is read by
 * rc.23 as a personal ssh row (owner = the definition's name), and a gateway that
 * runs a bound thread with no shared-environment support runs it on the SERVER.
 * So before redeploying rc.23 every binding to a definition row must go, on
 * purpose, tenant by tenant. Definition rows themselves stay (the rc.24 columns
 * are never dropped). Counts and names only, never a host or key.
 */
import { db } from "../../db/schema";
import type { BindingRow } from "../../db/environments";
import { releaseBinding } from "../env-runtime";

export interface SharedBindingCount {
  name: string;
  tenant: string;
  threads: number;
}

/** `tenant` undefined means every tenant (the caller asked for that explicitly). */
export async function sharedBindingCounts(tenant?: string): Promise<SharedBindingCount[]> {
  const pg = db.dialect === "pg";
  const rows = await db.query<{ name: string; tenant_id: string; n: number | string }>(
    `SELECT e.name AS name, ${pg ? "e.tenant_id" : "'default'"} AS tenant_id, COUNT(*) AS n
     FROM env_bindings b JOIN environments e ON e.id = b.env_id
     WHERE e.source = 'definition' ${tenant !== undefined && pg ? "AND e.tenant_id = ?" : ""}
     GROUP BY e.name${pg ? ", e.tenant_id" : ""} ORDER BY e.name`,
    tenant !== undefined && pg ? [tenant] : [],
  );
  return rows.map((r) => ({ name: r.name, tenant: r.tenant_id, threads: Number(r.n) })).filter((r) => tenant === undefined || r.tenant === tenant);
}

export interface UnbindDeps {
  /** Best-effort cleanup of the session's remote jobs on the machine. Default: releaseBinding, bounded in time. */
  release?: (removed: BindingRow, sessionId: string) => Promise<void>;
}

const RELEASE_BOUND_MS = 15_000;
const defaultRelease = async (removed: BindingRow, sessionId: string) => {
  await Promise.race([releaseBinding(removed, { sessionId }), new Promise<void>((r) => setTimeout(r, RELEASE_BOUND_MS))]);
};

/**
 * Delete the bindings to definition rows (of one tenant, or all of them), then
 * clean up each thread's remote jobs on the machine. Returns the threads
 * unbound per tenant. The cleanup never fails the unbind.
 */
export async function unbindShared(tenant: string | undefined, deps: UnbindDeps = {}): Promise<Array<{ tenant: string; threads: number }>> {
  const pg = db.dialect === "pg";
  const rows = await db.query<BindingRow & { tenant: string }>(
    `SELECT b.*, ${pg ? "e.tenant_id" : "'default'"} AS tenant
     FROM env_bindings b JOIN environments e ON e.id = b.env_id
     WHERE e.source = 'definition' ${tenant !== undefined && pg ? "AND e.tenant_id = ?" : ""}`,
    tenant !== undefined && pg ? [tenant] : [],
  );
  const mine = rows.filter((r) => tenant === undefined || r.tenant === tenant);
  const counts = new Map<string, number>();
  const release = deps.release ?? defaultRelease;
  for (const r of mine) {
    const gone = await db.run("DELETE FROM env_bindings WHERE channel_id = ? AND thread_ts = ? AND env_id = ?", [r.channel_id, r.thread_ts, r.env_id]);
    if ((gone.changes ?? 0) === 0) continue;
    counts.set(r.tenant, (counts.get(r.tenant) ?? 0) + 1);
    try {
      const sessions = await db.query<{ id: string }>("SELECT id FROM sessions WHERE slack_channel_id = ? AND slack_thread_ts = ?", [r.channel_id, r.thread_ts]);
      for (const s of sessions) await release(r, s.id);
    } catch (e) {
      console.warn(`[env] unbind cleanup skipped: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  return [...counts].map(([t, threads]) => ({ tenant: t, threads }));
}
