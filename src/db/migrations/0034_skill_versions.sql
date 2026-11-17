-- Version log of the skills on disk. Files stay the runtime authority: this
-- table is written only by the gateway or mono process, when a reconcile
-- finds a skill whose content hash differs from its latest row, and is never
-- read to run a skill. Rows are never updated, so a retired skill or a deleted
-- file keeps its history; they are deleted only when their persona is removed.
--
-- scope is 'global' for the shared base root, else the persona that owns the
-- overlay. content_hash is a sha256 over every file of the skill (relative
-- path and bytes, deterministic order; symlinks by their target, never
-- followed). skill_md is the SKILL.md text, cut at the 256 KB the console
-- reads (skill_md_truncated = 1 when cut). origin is bundled, installed or
-- agent as of the capture. captured_at is epoch ms like every other table.
CREATE TABLE IF NOT EXISTS skill_versions (
  scope               TEXT    NOT NULL,
  slug                TEXT    NOT NULL,
  version             INTEGER NOT NULL,
  tenant_id           TEXT    NOT NULL DEFAULT 'default',
  content_hash        TEXT    NOT NULL,
  skill_md            TEXT    NOT NULL,
  skill_md_truncated  INTEGER NOT NULL DEFAULT 0,
  file_count          INTEGER NOT NULL,
  total_bytes         BIGINT  NOT NULL,
  captured_at         BIGINT  NOT NULL,
  origin              TEXT    NOT NULL,
  PRIMARY KEY (scope, slug, version)
);
