-- Heartbeat wake: per agent, when it next needs to look and how its last wake
-- went. Times are epoch ms. Code-owned: the agent only proposes next_check_at,
-- and code clamps it. finished_at is when the agent last called finish_round.
CREATE TABLE IF NOT EXISTS heartbeat_wake_state (
  tenant_id      TEXT    NOT NULL DEFAULT 'default',
  agent_id       TEXT    NOT NULL,
  next_check_at  BIGINT,
  last_wake_at   BIGINT,
  finished_at    BIGINT,
  last_outcome   TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  checklist_hash TEXT,
  updated_at     BIGINT  NOT NULL,
  PRIMARY KEY (agent_id)
);
