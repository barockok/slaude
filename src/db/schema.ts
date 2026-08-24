/**
 * Process-wide DB handle + shared row types.
 *
 * `db` is the lazy dialect-agnostic client from ./client (sqlite by default,
 * Postgres/PGLite with SLAUDE_DB=pg). The sqlite schema bootstrap lives in
 * ./drivers/sqlite; Postgres schema lives in ./migrations/*.sql.
 */
export { db, getDb, dbDialect, __resetDbForTests } from "./client";
export type { DbClient } from "./client";
export { ensureCronPauseColumn } from "./drivers/sqlite";

export type SessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  model: string;
  working_dir: string;
  status: string;
  claude_started: number;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  permission_mode: string;
  engaged: number;
  persona_id: string;
};
