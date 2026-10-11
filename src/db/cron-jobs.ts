import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type CronJob = {
  id: string;
  slackTeamId: string | null;
  /** Slack app (api_app_id) the job was created under; null on older jobs.
   *  A run posts as this app when several are registered (D1.2). */
  slackAppId: string | null;
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
  /** /1on1 lock owner active when the job was created, or null. When set, the
   *  scheduler boots the run under this user's OAuth config dir (initiator
   *  isolation), mirroring the interactive 1on1 session. */
  oauthUser: string | null;
  /** Which persona owns the job. The scheduler keys the run's thread on this so
   *  the fire resolves the persona's session (soul + brain slice + config dir).
   *  'default' = single-bot persona. */
  personaId: string;
};

export async function create(args: {
  slackTeamId?: string;
  slackAppId?: string;
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
  oauthUser?: string;
  personaId?: string;
}): Promise<CronJob> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO cron_jobs (id, slack_team_id, slack_app_id, slack_channel_id, slack_thread_ts, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, target, when_active, oauth_user, persona_id, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      args.slackTeamId ?? null,
      args.slackAppId ?? null,
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
      args.oauthUser ?? null,
      args.personaId && args.personaId !== "default" ? args.personaId : "default",
    ],
  );
  return (await findById(id))!;
}

export async function findById(id: string): Promise<CronJob | null> {
  const row = await db.one<any>("SELECT * FROM cron_jobs WHERE id = ?", [id]);
  return row ? mapRow(row) : null;
}

export async function findByPrefix(prefix: string): Promise<CronJob | null> {
  if (prefix.length !== 8) return findById(prefix);
  const rows = await db.query<any>("SELECT * FROM cron_jobs WHERE active = 1 AND id LIKE ?", [`${prefix}%`]);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Ambiguous prefix — don't accidentally deactivate multiple jobs
    const matched = rows.map((r) => r.id.slice(0, 8)).join(", ");
    throw new Error(`Prefix \`${prefix}\` matches multiple jobs: ${matched}. Provide full ID.`);
  }
  return mapRow(rows[0]);
}

export async function findDue(now: number): Promise<CronJob[]> {
  const rows = await db.query<any>(
    `SELECT * FROM cron_jobs
     WHERE active = 1
       AND paused = 0
       AND next_run_at <= ?
     ORDER BY next_run_at`,
    [now],
  );
  return rows.map(mapRow);
}

/**
 * Claim one due occurrence by advancing next_run_at from the value the caller
 * observed. Exactly one claimer wins, whatever else is running.
 *
 * The schedule moves BEFORE the turn is dispatched, not after it completes.
 * Advancing at completion left the row due for the whole turn, so a cron
 * leader dying mid-turn handed the same occurrence to the next leader, and the
 * in-process re-entry guard could not see across replicas.
 *
 * Returns false when someone else already claimed it, or the job was paused or
 * deactivated in the meantime.
 */
export async function claimDue(id: string, observedNextRunAt: number, nextRunAt: number): Promise<boolean> {
  const r = await db.run(
    `UPDATE cron_jobs SET next_run_at = ?
     WHERE id = ? AND next_run_at = ? AND active = 1 AND paused = 0`,
    [nextRunAt, id, observedNextRunAt],
  );
  return (r.changes ?? 0) > 0;
}

/**
 * Give a claimed occurrence back, when the dispatch it was claimed for never
 * happened. Once a turn IS enqueued the queue owns its redelivery, so this is
 * only for a failure before that point. No-op if the row moved on since.
 */
export async function releaseClaim(id: string, claimedNextRunAt: number, restoreTo: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE cron_jobs SET next_run_at = ? WHERE id = ? AND next_run_at = ?",
    [restoreTo, id, claimedNextRunAt],
  );
  return (r.changes ?? 0) > 0;
}

/** Record how a run ended. The schedule already moved at claim time. */
export async function recordRun(id: string, lastResult: string): Promise<void> {
  await db.run(
    "UPDATE cron_jobs SET last_run_at = ?, last_result = ? WHERE id = ?",
    [Date.now(), lastResult, id],
  );
}

export async function updateNextRun(id: string, nextRunAt: number, lastResult: string): Promise<void> {
  await db.run(
    "UPDATE cron_jobs SET next_run_at = ?, last_run_at = ?, last_result = ? WHERE id = ?",
    [nextRunAt, Date.now(), lastResult, id],
  );
}

export async function deactivate(id: string): Promise<void> {
  await db.run("UPDATE cron_jobs SET active = 0 WHERE id = ?", [id]);
}

export async function pause(id: string): Promise<void> {
  await db.run("UPDATE cron_jobs SET paused = 1 WHERE id = ?", [id]);
}

export async function resume(id: string, nextRunAt: number): Promise<void> {
  await db.run("UPDATE cron_jobs SET paused = 0, next_run_at = ? WHERE id = ?", [nextRunAt, id]);
}

export async function update(
  id: string,
  args: {
    cronExpr?: string;
    prompt?: string;
    nextRunAt?: number;
    target?: "thread" | "channel";
    whenActive?: "fire" | "skip";
  },
): Promise<void> {
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
  await db.run(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`, values);
}

export async function listActive(): Promise<CronJob[]> {
  const rows = await db.query<any>("SELECT * FROM cron_jobs WHERE active = 1 ORDER BY paused, next_run_at");
  return rows.map(mapRow);
}

/** Active jobs (paused included: they can be resumed) that fire into this exact
 *  Slack thread and were created by anyone other than `userId`. */
export async function countForeignThreadJobs(slackChannelId: string, slackThreadTs: string, userId: string): Promise<number> {
  const row = await db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cron_jobs
     WHERE active = 1
       AND COALESCE(target, 'thread') = 'thread'
       AND slack_channel_id = ?
       AND slack_thread_ts = ?
       AND created_by <> ?`,
    [slackChannelId, slackThreadTs, userId],
  );
  return Number(row?.n ?? 0);
}

function mapRow(row: any): CronJob {
  return {
    id: row.id,
    slackTeamId: row.slack_team_id,
    slackAppId: row.slack_app_id ?? null,
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
    oauthUser: row.oauth_user ?? null,
    personaId: row.persona_id ?? "default",
  };
}
