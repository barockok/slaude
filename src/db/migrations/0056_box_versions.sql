-- box_versions: one row per version of a box, numbered per box (1, 2, 3). A
-- new version is recorded when the image digest or the policy changes. Rows
-- are never updated. image is <repository>@sha256:<digest>, digest the
-- sha256:<digest> part, policy the canonical policy JSON (no secret: a box
-- holds none), forced the policy's refresh.force. set_version is the manifest
-- version at which the row was written. hmac covers every column but the
-- timestamps and the author.
CREATE TABLE IF NOT EXISTS box_versions (
  tenant_id   TEXT    NOT NULL DEFAULT 'default',
  name        TEXT    NOT NULL,
  version     BIGINT  NOT NULL,
  image       TEXT    NOT NULL,
  digest      TEXT    NOT NULL,
  policy      TEXT    NOT NULL,
  forced      BOOLEAN NOT NULL DEFAULT FALSE,
  set_version BIGINT  NOT NULL,
  hmac        TEXT    NOT NULL,
  created_at  BIGINT  NOT NULL,
  created_by  TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, name, version)
);
