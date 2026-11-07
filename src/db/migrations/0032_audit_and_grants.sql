-- Audit trail and stored agent grants (agent platform phase 1).
--
-- audit_events: append-only at the code level. Insert and the retention purge
-- (SLAUDE_AUDIT_RETENTION_DAYS) are the only write paths. id is time sortable
-- (zero-padded epoch ms + random suffix) and doubles as the list cursor. Times
-- are epoch ms. summary and details are redacted before they are written.
-- Queries are keyed on id (time bounds and retention are id ranges), so the
-- indexes end in id, and id and action compare bytewise (COLLATE "C") like
-- sqlite's default BINARY.
CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT   COLLATE "C" PRIMARY KEY,
  tenant_id   TEXT   NOT NULL DEFAULT 'default',
  persona     TEXT,
  at          BIGINT NOT NULL,
  actor_kind  TEXT   NOT NULL,
  actor_id    TEXT   NOT NULL,
  action      TEXT   COLLATE "C" NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  decision    TEXT,
  session_id  TEXT,
  channel_id  TEXT,
  thread_ts   TEXT,
  summary     TEXT   NOT NULL DEFAULT '',
  details     JSONB  NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_events_scope ON audit_events (tenant_id, persona, id);
CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_id, id);

-- agent_grants: who may use or administer a persona, keyed by persona name.
-- A deny row for a user blocks them even where a channel grant admits.
-- expires_at is filtered at read time; there is no sweep.
CREATE TABLE IF NOT EXISTS agent_grants (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL DEFAULT 'default',
  persona      TEXT    NOT NULL,
  subject_kind TEXT    NOT NULL,
  subject_id   TEXT    NOT NULL,
  role         TEXT    NOT NULL,
  deny         BOOLEAN NOT NULL DEFAULT FALSE,
  dm_only      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   TEXT    NOT NULL,
  created_at   BIGINT  NOT NULL,
  expires_at   BIGINT,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_grants_persona ON agent_grants (tenant_id, persona);
