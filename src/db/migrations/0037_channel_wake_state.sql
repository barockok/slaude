-- Channel session mode: per agent and channel, when it next looks and how its
-- last wake went. open_run_id names the wake's ledger run until it settles.
CREATE TABLE IF NOT EXISTS channel_wake_state (
  tenant_id      TEXT    NOT NULL DEFAULT 'default',
  agent_id       TEXT    NOT NULL,
  channel_id     TEXT    NOT NULL,
  next_check_at  BIGINT,
  last_wake_at   BIGINT,
  finished_at    BIGINT,
  last_outcome   TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  checklist_hash TEXT,
  open_run_id    TEXT,
  updated_at     BIGINT  NOT NULL,
  PRIMARY KEY (agent_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_wake_open_run ON channel_wake_state (open_run_id);
