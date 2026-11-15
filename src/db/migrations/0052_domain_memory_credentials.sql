-- Domain memory and credentials (slice F, rc.22). Additive and nullable; every
-- old read and write behaves exactly as before.
--
-- mcp_credentials.user_id is a bookkeeping pointer from a person's credential
-- row to the user record its account maps to. NOTHING reads it for a decision:
-- credentials keep resolving slack_identities -> account -> mcp_credentials
-- (a guard test enforces this). A NULL pointer is normal (rows from before this
-- migration, or an account whose user is not known yet). Deleting a user nulls
-- the pointer; the merge engine repoints it before it deletes the loser row.
ALTER TABLE mcp_credentials ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user ON mcp_credentials (user_id);
-- An agent's row never holds a person pointer. Postgres only: SQLite cannot add
-- a CHECK without rebuilding the table, so the repo functions enforce it there.
ALTER TABLE mcp_credentials DROP CONSTRAINT IF EXISTS mcp_credentials_user_needs_account;
ALTER TABLE mcp_credentials ADD CONSTRAINT mcp_credentials_user_needs_account CHECK (user_id IS NULL OR account_id IS NOT NULL);

-- Operator tombstones: a revoke for the read-time memory union that outlives
-- the merge undo window. source_id is a user- slice name, or '*' for no union
-- at all. No foreign key on purpose: the row must survive a merge deleting the
-- user row (a read matches the live id plus its user_aliases.old_id values).
-- No tenant_id: deployment-global like users.
CREATE TABLE IF NOT EXISTS slice_tombstones (
  user_id    TEXT   NOT NULL,
  source_id  TEXT   NOT NULL,
  created_by TEXT   NOT NULL,
  reason     TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, source_id)
);
