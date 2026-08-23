-- Gateway state tables carried over from sqlite, each plus tenant_id.
-- skill_usage is intentionally absent (no readers or writers).

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'default',
  label        TEXT NOT NULL,
  status       TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  started_at   BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_running
  ON kb_ingest_jobs (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ignores (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'thread')),
  user_id     TEXT,
  channel_id  TEXT,
  thread_ts   TEXT,
  created_by  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT,
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ignores_user
  ON ignores (target_type, user_id) WHERE target_type = 'user';
CREATE INDEX IF NOT EXISTS idx_ignores_thread
  ON ignores (target_type, channel_id, thread_ts) WHERE target_type = 'thread';
CREATE INDEX IF NOT EXISTS idx_ignores_expires
  ON ignores (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cron_jobs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'default',
  slack_team_id    TEXT,
  slack_channel_id TEXT,
  slack_thread_ts  TEXT,
  channel_id       TEXT NOT NULL,
  thread_ts        TEXT,
  created_by       TEXT NOT NULL,
  cron_expr        TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  next_run_at      BIGINT NOT NULL,
  last_run_at      BIGINT,
  last_result      TEXT,
  paused           SMALLINT NOT NULL DEFAULT 0,
  active           SMALLINT NOT NULL DEFAULT 1,
  target           TEXT NOT NULL DEFAULT 'thread',
  when_active      TEXT NOT NULL DEFAULT 'fire',
  oauth_user       TEXT,
  persona_id       TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON cron_jobs (next_run_at) WHERE active = 1;

CREATE TABLE IF NOT EXISTS one_on_one_locks (
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  locked_user TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  open_scope  TEXT,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS mention_only_threads (
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS soul_overrides (
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  field      TEXT NOT NULL CHECK (field IN
               ('trustedChannels', 'allowedChannels', 'dmAllowedUsers', 'blockedUsers')),
  value      TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (field, value)
);
