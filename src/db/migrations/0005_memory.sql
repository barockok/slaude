-- Flat memory store (SLAUDE_MEMORY=sqlite provider), plus tenant_id.

CREATE TABLE IF NOT EXISTS memory_turns (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  session_id     TEXT NOT NULL,
  ts             BIGINT NOT NULL,
  user_text      TEXT NOT NULL,
  assistant_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_turns_session ON memory_turns (session_id, ts);

CREATE TABLE IF NOT EXISTS memory_facts (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  session_id TEXT,
  scope      TEXT NOT NULL DEFAULT 'session',
  ts         BIGINT NOT NULL,
  fact       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_session ON memory_facts (session_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_scope ON memory_facts (scope);
