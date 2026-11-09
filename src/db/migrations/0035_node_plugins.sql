-- The read-only plugin inventory: one row per node credential, replaced by the
-- report a node sends at start (design: docs/superpowers/specs/2026-11-09-plugin-inventory.md).
-- The node id and labels come from the verified credential, never the report.
CREATE TABLE IF NOT EXISTS node_plugins (
  node_id     TEXT   PRIMARY KEY,
  labels      TEXT   NOT NULL,
  reported_at BIGINT NOT NULL,
  report      TEXT   NOT NULL
);
