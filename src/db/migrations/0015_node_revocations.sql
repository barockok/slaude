-- Node credential revocation by id (node labels and routing spec §4.1). The
-- gateway rejects a signed node credential whose id has a row here and whose
-- iat is before revoked_before. Written by `bun run node-token revoke <id>`.
-- Postgres only: sqlite deployments skip revocation with a warning.
CREATE TABLE IF NOT EXISTS node_revocations (
  id             TEXT        PRIMARY KEY,
  revoked_before TIMESTAMPTZ NOT NULL
);
