/**
 * @deprecated Superseded by brain memoize (gbrain captures knowledge
 * automatically). The /ingest command no longer triggers this flow; this
 * module is retained only until removal. Do not wire new callers.
 */
import { db } from "./schema";

export const STALE_AFTER_MS = 10 * 60 * 1000; // 10 min

export type IngestJob = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "crashed";
  triggered_by: string;
  started_at: number;
  heartbeat_at: number;
};

function nowMs(): number {
  return Date.now();
}

function rid(): string {
  return `${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function tryAcquire(label: string, triggeredBy: string): Promise<IngestJob | null> {
  await reapStale();
  const t = nowMs();
  const id = rid();
  try {
    await db.run(
      `INSERT INTO kb_ingest_jobs (id, label, status, triggered_by, started_at, heartbeat_at)
       VALUES (?, ?, 'running', ?, ?, ?)`,
      [id, label, triggeredBy, t, t],
    );
  } catch {
    return null; // unique index on status='running' triggered
  }
  return { id, label, status: "running", triggered_by: triggeredBy, started_at: t, heartbeat_at: t };
}

export async function heartbeat(id: string): Promise<void> {
  await db.run("UPDATE kb_ingest_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'", [nowMs(), id]);
}

export async function release(id: string, finalStatus: "completed" | "failed" | "crashed"): Promise<void> {
  await db.run("UPDATE kb_ingest_jobs SET status = ?, heartbeat_at = ? WHERE id = ?", [finalStatus, nowMs(), id]);
}

export async function runningJob(): Promise<IngestJob | null> {
  return db.one<IngestJob>("SELECT * FROM kb_ingest_jobs WHERE status = 'running' LIMIT 1");
}

export async function reapStale(): Promise<string[]> {
  const cutoff = nowMs() - STALE_AFTER_MS;
  const stale = await db.query<{ id: string }>(
    "SELECT id FROM kb_ingest_jobs WHERE status = 'running' AND heartbeat_at < ?",
    [cutoff],
  );
  for (const r of stale) {
    await db.run("UPDATE kb_ingest_jobs SET status = 'crashed' WHERE id = ?", [r.id]);
  }
  return stale.map((r) => r.id);
}
