import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type CronJob = {
  id: string;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  channelId: string;
  threadTs: string | null;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  paused: number;
  active: number;
  target: "thread" | "channel";
  /** 'fire' (default) runs even when a human is active in the target;
   *  'skip' defers the run while the session is live. */
  whenActive: "fire" | "skip";
};

export function create(args: {
  slackTeamId?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  channelId: string;
  threadTs?: string;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
  target?: "thread" | "channel";
  whenActive?: "fire" | "skip";
}): CronJob {
  const id = randomUUID();
  db.run(
    `INSERT INTO cron_jobs (id, slack_team_id, slack_channel_id, slack_thread_ts, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, target, when_active, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      args.slackTeamId ?? null,
      args.slackChannelId ?? null,
      args.slackThreadTs ?? null,
      args.channelId,
      args.threadTs ?? null,
      args.createdBy,
      args.cronExpr,
      args.prompt,
      args.nextRunAt,
      args.target ?? "thread",
      args.whenActive ?? "fire",
    ],
  );
  return findById(id)!;
}

export function findById(id: string): CronJob | null {
  const row = db.query("SELECT * FROM cron_jobs WHERE id = ?").get(id) as any;
  return row ? mapRow(row) : null;
}

export function findByPrefix(prefix: string): CronJob | null {
  if (prefix.length !== 8) return findById(prefix);
  const rows = db
    .query("SELECT * FROM cron_jobs WHERE active = 1 AND id LIKE ?")
    .all(`${prefix}%`) as any[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Ambiguous prefix — don't accidentally deactivate multiple jobs
    const matched = rows.map((r) => r.id.slice(0, 8)).join(", ");
    throw new Error(`Prefix \`${prefix}\` matches multiple jobs: ${matched}. Provide full ID.`);
  }
  return mapRow(rows[0]);
}

export function findDue(now: number): CronJob[] {
  const rows = db
    .query(
      `SELECT * FROM cron_jobs
       WHERE active = 1
         AND paused = 0
         AND next_run_at <= ?
       ORDER BY next_run_at`,
    )
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

export function pause(id: string): void {
  db.run("UPDATE cron_jobs SET paused = 1 WHERE id = ?", [id]);
}

export function resume(id: string, nextRunAt: number): void {
  db.run("UPDATE cron_jobs SET paused = 0, next_run_at = ? WHERE id = ?", [nextRunAt, id]);
}

export function update(
  id: string,
  args: {
    cronExpr?: string;
    prompt?: string;
    nextRunAt?: number;
    target?: "thread" | "channel";
    whenActive?: "fire" | "skip";
  },
): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (args.cronExpr !== undefined) {
    sets.push("cron_expr = ?");
    values.push(args.cronExpr);
  }
  if (args.prompt !== undefined) {
    sets.push("prompt = ?");
    values.push(args.prompt);
  }
  if (args.nextRunAt !== undefined) {
    sets.push("next_run_at = ?");
    values.push(args.nextRunAt);
  }
  if (args.target !== undefined) {
    sets.push("target = ?");
    values.push(args.target);
  }
  if (args.whenActive !== undefined) {
    sets.push("when_active = ?");
    values.push(args.whenActive);
  }
  if (!sets.length) return;
  values.push(id);
  db.run(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`, values);
}

export function listActive(): CronJob[] {
  const rows = db
    .query("SELECT * FROM cron_jobs WHERE active = 1 ORDER BY paused, next_run_at")
    .all() as any[];
  return rows.map(mapRow);
}

function mapRow(row: any): CronJob {
  return {
    id: row.id,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    createdBy: row.created_by,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    paused: row.paused ?? 0,
    active: row.active,
    target: (row.target ?? "thread") as "thread" | "channel",
    whenActive: (row.when_active ?? "fire") as "fire" | "skip",
  };
}
