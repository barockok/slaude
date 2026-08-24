-- Sessions: same shape as sqlite plus tenant_id. Boolean-ish flags stay
-- SMALLINT 0/1 so row objects are identical across dialects.

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default',
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  title            TEXT,
  model            TEXT NOT NULL,
  working_dir      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'idle',
  claude_started   SMALLINT NOT NULL DEFAULT 0,
  slack_team_id    TEXT,
  slack_channel_id TEXT,
  slack_thread_ts  TEXT,
  permission_mode  TEXT NOT NULL DEFAULT 'default',
  engaged          SMALLINT NOT NULL DEFAULT 1,
  persona_id       TEXT NOT NULL DEFAULT 'default',
  UNIQUE (slack_team_id, slack_channel_id, slack_thread_ts, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_thread
  ON sessions (slack_team_id, slack_channel_id, slack_thread_ts);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id);
