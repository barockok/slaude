import { Database } from "bun:sqlite";
import { paths, ensureHome } from "../config/home";

ensureHome();

export const db = new Database(paths.db, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

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
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON cron_jobs (next_run_at) WHERE active = 1;

CREATE TABLE IF NOT EXISTS connections (
  id                  TEXT PRIMARY KEY,
  owner_slack_user_id TEXT NOT NULL,
  service             TEXT NOT NULL,
  scope               TEXT NOT NULL,
  team_id             TEXT,
  channel_id          TEXT,
  thread_ts           TEXT,
  auth_strategy       TEXT NOT NULL,
  cred_ciphertext     TEXT NOT NULL,
  key_id              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  expires_at          INTEGER,
  status              TEXT NOT NULL DEFAULT 'active'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_thread
  ON connections (owner_slack_user_id, service, team_id, channel_id, thread_ts)
  WHERE scope = 'thread';

CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_slaude
  ON connections (owner_slack_user_id, service)
  WHERE scope = 'slaude';

CREATE INDEX IF NOT EXISTS idx_conn_thread_lookup
  ON connections (service, team_id, channel_id, thread_ts) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_conn_expires
  ON connections (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS connection_grants (
  id                     TEXT PRIMARY KEY,
  connection_id          TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  team_id                TEXT NOT NULL,
  channel_id             TEXT NOT NULL,
  thread_ts              TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  revoked_at             INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_unique
  ON connection_grants (connection_id, borrower_slack_user_id);

CREATE TABLE IF NOT EXISTS connection_audit (
  id                     TEXT PRIMARY KEY,
  connection_id          TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  approver_id            TEXT,
  service                TEXT,
  tool                   TEXT,
  args_hash              TEXT,
  decision               TEXT NOT NULL,
  created_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS one_on_one_locks (
  channel_id  TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  locked_user TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
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
};

export type ConnectionRow = {
  id: string;
  owner_slack_user_id: string;
  service: string;
  scope: "thread" | "slaude";
  team_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  auth_strategy: "token" | "cookie";
  cred_ciphertext: string;
  key_id: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  status: "active" | "expired" | "revoked";
};

export type ConnectionGrantRow = {
  id: string;
  connection_id: string;
  borrower_slack_user_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  created_at: number;
  revoked_at: number | null;
};
