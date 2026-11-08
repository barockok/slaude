-- Owner guardrails (design: docs/superpowers/specs/2026-11-08-owner-guardrails.md).
--
-- The database is the only runtime source of a guardrail: files on disk are
-- authoring input (the deploy repo's guardrails/ folder, `slaude guardrails
-- import`), never read by a session.
--
-- guardrails: one row per guardrail, GUARDRAIL.md as written. sha is the
-- sha256 of md; source is file | git | console. enabled is the console kill
-- switch (kept across syncs; the frontmatter's own `enabled` is separate).
-- version is the manifest version of the row's last write. hmac covers
-- (tenant, slug, md, version, enabled, source, sha).
CREATE TABLE IF NOT EXISTS guardrails (
  tenant_id  TEXT    NOT NULL DEFAULT 'default',
  slug       TEXT    NOT NULL,
  md         TEXT    NOT NULL,
  sha        TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  version    BIGINT  NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  hmac       TEXT    NOT NULL,
  updated_at BIGINT  NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, slug)
);

-- guardrail_overrides: a console edit of a guardrail (written from phase B).
-- Kept across syncs; behind source when base_sha differs from the source
-- row's sha. hmac covers (tenant, slug, md, base_sha, version).
CREATE TABLE IF NOT EXISTS guardrail_overrides (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  slug       TEXT   NOT NULL,
  md         TEXT   NOT NULL,
  base_sha   TEXT   NOT NULL,
  version    BIGINT NOT NULL,
  author     TEXT   NOT NULL,
  hmac       TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, slug)
);

-- guardrails_manifest: one row per tenant. Per-row HMACs do not cover the
-- set (a deleted row or a replayed older row would still verify), so this
-- row signs the sorted (slug, version, enabled) list and the override list,
-- and is written in the same transaction as every row change. version only
-- grows; it is an explicit input of the runtime bundle's ETag.
CREATE TABLE IF NOT EXISTS guardrails_manifest (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  id         TEXT   NOT NULL DEFAULT 'manifest',
  version    BIGINT NOT NULL,
  entries    TEXT   NOT NULL,
  hmac       TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
