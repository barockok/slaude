-- boxes_manifest: one row per tenant. Per-row HMACs do not cover the set (a
-- deleted row or a replayed older row would still verify), so this row signs
-- the sorted (name, version, set_version) lists of boxes and box_versions, and
-- is written in the same transaction as every row change. version only grows;
-- it is an explicit input of the runtime bundle's ETag.
CREATE TABLE IF NOT EXISTS boxes_manifest (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  id         TEXT   NOT NULL DEFAULT 'manifest',
  version    BIGINT NOT NULL,
  entries    TEXT   NOT NULL,
  hmac       TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
