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

export function tryAcquire(label: string, triggeredBy: string): IngestJob | null {
  reapStale();
  const t = nowMs();
  const id = rid();
  try {
    db.run(
      `INSERT INTO kb_ingest_jobs (id, label, status, triggered_by, started_at, heartbeat_at)
       VALUES (?, ?, 'running', ?, ?, ?)`,
      [id, label, triggeredBy, t, t],
    );
  } catch {
    return null; // unique index on status='running' triggered
  }
  return { id, label, status: "running", triggered_by: triggeredBy, started_at: t, heartbeat_at: t };
}

export function heartbeat(id: string): void {
  db.run("UPDATE kb_ingest_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'", [nowMs(), id]);
}

export function release(id: string, finalStatus: "completed" | "failed" | "crashed"): void {
  db.run("UPDATE kb_ingest_jobs SET status = ?, heartbeat_at = ? WHERE id = ?", [finalStatus, nowMs(), id]);
}

export function runningJob(): IngestJob | null {
  const row = db.query("SELECT * FROM kb_ingest_jobs WHERE status = 'running' LIMIT 1").get() as IngestJob | null;
  return row ?? null;
}

export function reapStale(): string[] {
  const cutoff = nowMs() - STALE_AFTER_MS;
  const stale = db.query("SELECT id FROM kb_ingest_jobs WHERE status = 'running' AND heartbeat_at < ?").all(cutoff as any) as Array<{ id: string }>;
  for (const r of stale) {
    db.run("UPDATE kb_ingest_jobs SET status = 'crashed' WHERE id = ?", [r.id]);
  }
  return stale.map((r) => r.id);
}
