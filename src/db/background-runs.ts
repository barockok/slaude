import { randomUUID } from "node:crypto";
import { db } from "./schema";
import type { TokenCounts } from "../background/prices";

export type RunOutcome = "ok" | "skipped-budget" | "stopped-budget" | "error";

export interface BackgroundRun {
  id: string;
  agentId: string;
  pass: string;
  scope: string;
  model: string | null;
  tokens: TokenCounts;
  costUsd: number;
  startedAt: number;
  finishedAt: number | null;
  outcome: RunOutcome | null;
  day: string;
}

interface Row {
  id: string;
  agent_id: string;
  pass: string;
  scope: string;
  model: string | null;
  tokens_input: number | string;
  tokens_output: number | string;
  tokens_cache_read: number | string;
  tokens_cache_write: number | string;
  cost_usd: number | string;
  started_at: number | string;
  finished_at: number | string | null;
  outcome: RunOutcome | null;
  day: string;
}

function toRun(r: Row): BackgroundRun {
  return {
    id: r.id,
    agentId: r.agent_id,
    pass: r.pass,
    scope: r.scope,
    model: r.model,
    tokens: {
      input: Number(r.tokens_input),
      output: Number(r.tokens_output),
      cache_read: Number(r.tokens_cache_read),
      cache_write: Number(r.tokens_cache_write),
    },
    costUsd: Number(r.cost_usd),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    outcome: r.outcome,
    day: r.day,
  };
}

/** Open a run row (outcome NULL until finish). `scope` is 'agent' or 'user:<id>'. */
export async function start(row: {
  agentId: string;
  pass: string;
  scope: string;
  model?: string | null;
  day: string;
  startedAt?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO background_runs (id, agent_id, pass, scope, model, started_at, day)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, row.agentId, row.pass, row.scope, row.model ?? null, row.startedAt ?? Date.now(), row.day],
  );
  return id;
}

export async function finish(
  id: string,
  r: { tokens: TokenCounts; costUsd: number; outcome: RunOutcome },
): Promise<void> {
  await db.run(
    `UPDATE background_runs
        SET tokens_input = ?, tokens_output = ?, tokens_cache_read = ?, tokens_cache_write = ?,
            cost_usd = ?, outcome = ?, finished_at = ?
      WHERE id = ?`,
    [r.tokens.input, r.tokens.output, r.tokens.cache_read, r.tokens.cache_write, r.costUsd, r.outcome, Date.now(), id],
  );
}

/** Total USD recorded for an agent on a persona-local day. */
export async function spentOn(agentId: string, day: string): Promise<number> {
  const row = await db.one<{ total: number | string | null }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM background_runs WHERE agent_id = ? AND day = ?",
    [agentId, day],
  );
  return Number(row?.total ?? 0);
}

/** Cost of the pass's most recent ok run, or null if it never finished ok. */
export async function lastOkCost(agentId: string, pass: string): Promise<number | null> {
  const row = await db.one<{ cost_usd: number | string }>(
    `SELECT cost_usd FROM background_runs
      WHERE agent_id = ? AND pass = ? AND outcome = 'ok'
      ORDER BY started_at DESC LIMIT 1`,
    [agentId, pass],
  );
  return row ? Number(row.cost_usd) : null;
}

/** True when the pass has a row for the day with one of `outcomes` (default: any finished outcome except skipped-budget). */
export async function ranOn(
  agentId: string,
  pass: string,
  day: string,
  outcomes: RunOutcome[] = ["ok", "stopped-budget", "error"],
): Promise<boolean> {
  const marks = outcomes.map(() => "?").join(", ");
  const row = await db.one<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM background_runs
      WHERE agent_id = ? AND pass = ? AND day = ? AND outcome IN (${marks})`,
    [agentId, pass, day, ...outcomes],
  );
  return Number(row?.n ?? 0) > 0;
}

/** Runs with day in [fromDay, toDay] (inclusive, YYYY-MM-DD compares lexically), oldest first. */
export async function listBetween(agentId: string, fromDay: string, toDay: string): Promise<BackgroundRun[]> {
  const rows = await db.query<Row>(
    `SELECT * FROM background_runs
      WHERE agent_id = ? AND day >= ? AND day <= ?
      ORDER BY started_at ASC`,
    [agentId, fromDay, toDay],
  );
  return rows.map(toRun);
}
