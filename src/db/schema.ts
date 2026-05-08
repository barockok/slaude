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
  UNIQUE(slack_team_id, slack_channel_id, slack_thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_sessions_thread
  ON sessions (slack_team_id, slack_channel_id, slack_thread_ts);

CREATE TABLE IF NOT EXISTS skill_usage (
  skill TEXT PRIMARY KEY,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
`;

for (const stmt of SCHEMA.split(";")) {
  const s = stmt.trim();
  if (s) db.run(s);
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
};
