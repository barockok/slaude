-- Cross-replica gate state (M2 consumers) and Slack event dedup.

CREATE TABLE IF NOT EXISTS pending_gates (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('perm', 'approval', 'mcp_connect')),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  resolved_by TEXT,
  resolved_at BIGINT,
  expires_at  BIGINT,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_gates_session ON pending_gates (session_id);
CREATE INDEX IF NOT EXISTS idx_pending_gates_open
  ON pending_gates (expires_at) WHERE status = 'pending';

-- Dedup across gateway replicas. Rows older than 1h are purged by the gateway.
CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  ts       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seen_events_ts ON seen_events (ts);
