-- Ledger of background learning passes (nightly review, lessons upkeep, skill
-- check/review, quiet moments, digest). One row per attempted run; the daily
-- budget gate sums cost_usd by (agent_id, day). `scope` is 'agent' or
-- 'user:<id>', never content. `day` is the persona-local YYYY-MM-DD at
-- started_at. Timestamps are epoch ms like every other table here.
CREATE TABLE IF NOT EXISTS background_runs (
  id                 TEXT             PRIMARY KEY,
  tenant_id          TEXT             NOT NULL DEFAULT 'default',
  agent_id           TEXT             NOT NULL,
  pass               TEXT             NOT NULL,
  scope              TEXT             NOT NULL,
  model              TEXT,
  tokens_input       BIGINT           NOT NULL DEFAULT 0,
  tokens_output      BIGINT           NOT NULL DEFAULT 0,
  tokens_cache_read  BIGINT           NOT NULL DEFAULT 0,
  tokens_cache_write BIGINT           NOT NULL DEFAULT 0,
  cost_usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at         BIGINT           NOT NULL,
  finished_at        BIGINT,
  -- ok | skipped-budget | stopped-budget | error; NULL while running.
  outcome            TEXT,
  day                TEXT             NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_background_runs_agent_day ON background_runs (agent_id, day);
