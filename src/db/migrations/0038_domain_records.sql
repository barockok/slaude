-- Domain records (slice B of the 2026-11-12 domain model): users, the bindings
-- that join them to services, boundaries (a Slack channel, later a WhatsApp
-- group) and the alias rows a merge leaves behind.
--
-- Deployment-global, like accounts: a user is a person, not a tenant's row.
-- Nothing reads these for access yet. accounts and slack_identities stay the
-- authority; bindings are a projection kept in step by src/db/domain.ts.
--
-- A binding is unique per (service, kind, workspace, value). Slack ids are per
-- workspace, so a Slack binding must carry its workspace (the CHECK); email
-- and other workspace-less services use the empty string.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT   PRIMARY KEY,
  kind         TEXT   NOT NULL DEFAULT 'person',
  display_name TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bindings (
  id          TEXT   PRIMARY KEY,
  user_id     TEXT   NOT NULL REFERENCES users (id),
  service     TEXT   NOT NULL,
  kind        TEXT   NOT NULL,
  workspace   TEXT   NOT NULL DEFAULT '',
  value       TEXT   NOT NULL,
  state       TEXT   NOT NULL DEFAULT 'observed',
  source      TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  verified_at BIGINT,
  UNIQUE (service, kind, workspace, value),
  CHECK (state IN ('declared', 'observed', 'verified')),
  CHECK (service <> 'slack' OR workspace <> '')
);
CREATE INDEX IF NOT EXISTS idx_bindings_user ON bindings (user_id);

CREATE TABLE IF NOT EXISTS boundaries (
  id           TEXT   PRIMARY KEY,
  kind         TEXT   NOT NULL DEFAULT 'channel',
  display_name TEXT,
  service      TEXT   NOT NULL,
  workspace    TEXT   NOT NULL DEFAULT '',
  value        TEXT   NOT NULL,
  state        TEXT   NOT NULL DEFAULT 'observed',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE (service, workspace, value),
  CHECK (state IN ('declared', 'observed', 'verified')),
  CHECK (service <> 'slack' OR workspace <> '')
);

-- A merged user's old id keeps resolving here. The only merge record: users
-- carries no merged_into column. audit rows are never rewritten.
CREATE TABLE IF NOT EXISTS user_aliases (
  old_id         TEXT   PRIMARY KEY,
  user_id        TEXT   NOT NULL REFERENCES users (id),
  merged_at      BIGINT NOT NULL,
  audit_event_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_aliases_user ON user_aliases (user_id);
