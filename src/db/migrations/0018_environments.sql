-- Environments: saved, named, per-person execution environments for /env and
-- /remote, and the thread → environment binding that replaces remote_targets.
-- See docs/superpowers/specs/2026-10-19-remote-environments-design.md §9.
-- remote_targets stays for one release: rows are converted on first read
-- (src/db/environments.ts) and the table is dropped later.
CREATE TABLE IF NOT EXISTS environments (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL DEFAULT 'default',
  team_id     TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  -- JSON, non-secret fields only. Sensitive (an address): never echoed.
  config      TEXT    NOT NULL,
  -- src/db/crypto.ts envelope (AES-256-GCM) of a JSON object, or NULL.
  secrets     TEXT,
  default_dir TEXT,
  created_at  BIGINT  NOT NULL,
  updated_at  BIGINT  NOT NULL,
  UNIQUE (team_id, user_id, name)
);

CREATE TABLE IF NOT EXISTS env_bindings (
  tenant_id    TEXT    NOT NULL DEFAULT 'default',
  channel_id   TEXT    NOT NULL,
  thread_ts    TEXT    NOT NULL,
  env_id       TEXT    NOT NULL,
  dir          TEXT    NOT NULL,
  lock_by_env  INTEGER NOT NULL DEFAULT 0,
  -- Provisioned kinds: crypto.ts envelope of the sandbox endpoint, NULL until
  -- provisioned (or after an idle teardown).
  endpoint     TEXT,
  -- Bumped on every provision, so a re-provisioned sandbox changes the
  -- session fingerprint and warm sessions reconnect.
  generation   INTEGER NOT NULL DEFAULT 0,
  last_used_at BIGINT  NOT NULL,
  created_at   BIGINT  NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_env_bindings_env ON env_bindings (env_id);
