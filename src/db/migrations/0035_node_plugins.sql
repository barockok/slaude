-- The read-only plugin inventory: one row per node credential and process, from
-- the single report a node process sends at start (design:
-- docs/superpowers/specs/2026-11-09-plugin-inventory.md). The node id and labels
-- come from the verified credential, never the report. instance_id is the process
-- id the node heartbeats under; it is unique so that no second credential can
-- claim a live process.
CREATE TABLE IF NOT EXISTS node_plugins (
  node_id     TEXT   NOT NULL,
  instance_id TEXT   NOT NULL,
  labels      TEXT   NOT NULL,
  reported_at BIGINT NOT NULL,
  report      TEXT   NOT NULL,
  PRIMARY KEY (node_id, instance_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_plugins_instance ON node_plugins (instance_id);
