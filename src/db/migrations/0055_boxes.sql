-- Boxes (design: docs/superpowers/specs/2026-11-24-box-design.md).
--
-- boxes: one row per box of a tenant, as the deploy repo's boxes/<name>/box.yaml
-- declares it. version is the box's current version number (a row of
-- box_versions, 0056); set_version is the manifest version (0057) of the row's
-- last write. hmac covers (tenant, name, description, version, set_version).
-- Written only by a persona sync; nothing reads it while SLAUDE_BOX is off.
CREATE TABLE IF NOT EXISTS boxes (
  tenant_id   TEXT   NOT NULL DEFAULT 'default',
  name        TEXT   NOT NULL,
  description TEXT   NOT NULL DEFAULT '',
  version     BIGINT NOT NULL,
  set_version BIGINT NOT NULL,
  hmac        TEXT   NOT NULL,
  updated_at  BIGINT NOT NULL,
  updated_by  TEXT   NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
