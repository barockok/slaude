import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type CronJob = {
  id: string;
  channelId: string;
  threadTs: string | null;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  active: number;
};

export function create(args: {
  channelId: string;
  threadTs?: string;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
}): CronJob {
  const id = randomUUID();
  db.run(
    `INSERT INTO cron_jobs (id, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, args.channelId, args.threadTs ?? null, args.createdBy, args.cronExpr, args.prompt, args.nextRunAt],
  );
  return findById(id)!;
}

export function findById(id: string): CronJob | null {
  const row = db.query("SELECT * FROM cron_jobs WHERE id = ?").get(id) as any;
  return row ? mapRow(row) : null;
}

export function findDue(now: number): CronJob[] {
  const rows = db
    .query("SELECT * FROM cron_jobs WHERE active = 1 AND next_run_at <= ?")
    .all(now) as any[];
  return rows.map(mapRow);
}

export function updateNextRun(id: string, nextRunAt: number, lastResult: string): void {
  db.run(
    "UPDATE cron_jobs SET next_run_at = ?, last_run_at = ?, last_result = ? WHERE id = ?",
    [nextRunAt, Date.now(), lastResult, id],
  );
}

export function deactivate(id: string): void {
  db.run("UPDATE cron_jobs SET active = 0 WHERE id = ?", [id]);
}

export function listActive(): CronJob[] {
  const rows = db.query("SELECT * FROM cron_jobs WHERE active = 1 ORDER BY next_run_at").all() as any[];
  return rows.map(mapRow);
}

function mapRow(row: any): CronJob {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    createdBy: row.created_by,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    active: row.active,
  };
}
