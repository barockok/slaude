import { Database } from "bun:sqlite";
import { paths, ensureHome } from "../config/home";

ensureHome();

export const db = new Database(paths.db, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

export function ensureCronPauseColumn(database: Database): void {
  const cols = database.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "paused")) {
    database.run(`ALTER TABLE cron_jobs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  claude_started INTEGER NOT NULL DEFAULT 0,
  slack_team_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  engaged INTEGER NOT NULL DEFAULT 1,
  UNIQUE(slack_team_id, slack_channel_id, slack_thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_sessions_thread
  ON sessions (slack_team_id, slack_channel_id, slack_thread_ts);

CREATE TABLE IF NOT EXISTS skill_usage (
  skill TEXT PRIMARY KEY,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_running
  ON kb_ingest_jobs (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ignores (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('user','thread')),
  user_id TEXT,
  channel_id TEXT,
  thread_ts TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_ignores_user
  ON ignores (target_type, user_id) WHERE target_type = 'user';

CREATE INDEX IF NOT EXISTS idx_ignores_thread
  ON ignores (target_type, channel_id, thread_ts) WHERE target_type = 'thread';

CREATE INDEX IF NOT EXISTS idx_ignores_expires
  ON ignores (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  slack_team_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  created_by TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_result TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON cron_jobs (next_run_at) WHERE active = 1;

CREATE TABLE IF NOT EXISTS one_on_one_locks (
  channel_id  TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  locked_user TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS mention_only_threads (
  channel_id TEXT    NOT NULL,
  thread_ts  TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS soul_overrides (
  field      TEXT    NOT NULL CHECK(field IN
              ('trustedChannels','allowedChannels','dmAllowedUsers','blockedUsers')),
  value      TEXT    NOT NULL,
  action     TEXT    NOT NULL CHECK(action IN ('add','remove')),
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (field, value)
);
`;

for (const stmt of SCHEMA.split(";")) {
  const s = stmt.trim();
  if (s) db.run(s);
}

// Migration: backfill permission_mode column on existing dbs.
const sessionCols = db.query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
if (!sessionCols.some((c) => c.name === "permission_mode")) {
  db.run(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'`);
}
// Migration: per-thread engagement flag (disengage must survive restarts).
if (!sessionCols.some((c) => c.name === "engaged")) {
  db.run(`ALTER TABLE sessions ADD COLUMN engaged INTEGER NOT NULL DEFAULT 1`);
}

// Migration: add Slack key columns to cron_jobs for real thread sessions.
const cronCols = db.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{ name: string }>;
if (!cronCols.some((c) => c.name === "slack_team_id")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN slack_team_id TEXT`);
}
if (!cronCols.some((c) => c.name === "slack_channel_id")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN slack_channel_id TEXT`);
}
if (!cronCols.some((c) => c.name === "slack_thread_ts")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN slack_thread_ts TEXT`);
}
// Backfill: copy channel_id → slack_channel_id, thread_ts → slack_thread_ts for existing rows
// so cron jobs created before this migration continue to work.
const hasBackfill = db.query("SELECT 1 FROM cron_jobs WHERE slack_channel_id IS NULL LIMIT 1").get();
if (hasBackfill) {
  db.run(`UPDATE cron_jobs SET slack_channel_id = channel_id, slack_thread_ts = thread_ts WHERE slack_channel_id IS NULL`);
}

// Migration: add channel-vs-thread posting target to cron_jobs.
if (!cronCols.some((c) => c.name === "target")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'thread'`);
}

// Migration: add per-job active-session behavior. 'fire' (default) runs the job
// even when a human is live in the target thread/channel; 'skip' defers that run.
if (!cronCols.some((c) => c.name === "when_active")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN when_active TEXT NOT NULL DEFAULT 'fire'`);
}

// Migration: add pause lifecycle state. `active` remains the soft-delete bit;
// paused jobs stay listed but don't fire on schedule.
ensureCronPauseColumn(db);

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
};
