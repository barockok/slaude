-- Every MCP OAuth credential, whoever owns it, held by the gateway.
--
-- Exactly one owner per row, enforced here rather than in application code.
-- Two nullable owner columns instead of a polymorphic owner_kind/owner_id pair,
-- so account_id can carry a real foreign key and deleting an account deletes
-- that person's credentials through the database's own cascade.
--
-- Both UNIQUE constraints are safe with nullable columns: NULLs are distinct in
-- a unique constraint on Postgres and SQLite alike, so an agent row never
-- collides on (account_id, server_key) and a person's row never collides on the
-- agent triple.
--
-- payload is AES-256-GCM (src/db/crypto.ts). expires_at is the only plaintext
-- field, and only so expiry is queryable without decrypting every row.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  id            TEXT   PRIMARY KEY,
  account_id    TEXT   REFERENCES accounts (id) ON DELETE CASCADE,
  agent_tenant  TEXT,
  agent_persona TEXT,
  server_key    TEXT   NOT NULL,
  payload       TEXT   NOT NULL,
  expires_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  CHECK ((account_id IS NOT NULL) <> (agent_tenant IS NOT NULL)),
  CHECK ((agent_tenant IS NULL) = (agent_persona IS NULL)),
  UNIQUE (account_id, server_key),
  UNIQUE (agent_tenant, agent_persona, server_key)
);
