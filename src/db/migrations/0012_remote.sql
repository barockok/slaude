-- /remote: per-thread remote execution target and per-person SSH keys.
-- See docs/superpowers/specs/2026-09-29-remote-exec-design.md §3.
CREATE TABLE IF NOT EXISTS remote_targets (
  tenant_id      TEXT    NOT NULL DEFAULT 'default',
  channel_id     TEXT    NOT NULL,
  thread_ts      TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  addr           TEXT    NOT NULL,
  dir            TEXT    NOT NULL,
  lock_by_remote INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT  NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

-- private_key holds a src/db/crypto.ts envelope (AES-256-GCM), never plaintext.
CREATE TABLE IF NOT EXISTS remote_keys (
  team_id     TEXT   NOT NULL,
  user_id     TEXT   NOT NULL,
  public_key  TEXT   NOT NULL,
  private_key TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
