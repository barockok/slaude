-- Personas as code: a repository is the source of truth, a pipeline pushes the
-- whole set, and runtime overrides last until the next sync. Two layers:
--
--   personas            the desired layer — written by sync, and by a runtime
--                       onboard for origin='runtime' rows only
--   persona_overrides   the runtime layer — one row per overridden field,
--                       deleted wholesale by every sync
--
-- persona_sync_state holds the live revision per tenant. Its committed_at is
-- what refuses an out-of-order pipeline run, and its existence is what marks a
-- tenant as managed: a tenant with no row still reads the filesystem.
--
-- user_token and persona_overrides.value hold AES-256-GCM envelopes
-- (src/db/crypto.ts) wherever a secret can appear.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS slack_user_id   TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS user_token      TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS origin          TEXT NOT NULL DEFAULT 'git';
ALTER TABLE personas ADD COLUMN IF NOT EXISTS source_revision TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS tombstoned_at   BIGINT;

DO $$ BEGIN
  ALTER TABLE personas ADD CONSTRAINT personas_origin_chk CHECK (origin IN ('git', 'runtime'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS persona_overrides (
  tenant_id    TEXT   NOT NULL REFERENCES tenants (id),
  persona_name TEXT   NOT NULL,
  field        TEXT   NOT NULL CHECK (field IN ('soul', 'model', 'mcp')),
  value        TEXT   NOT NULL,
  set_by       TEXT   NOT NULL,
  set_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, persona_name, field)
);

CREATE TABLE IF NOT EXISTS persona_sync_state (
  tenant_id        TEXT   PRIMARY KEY REFERENCES tenants (id),
  revision         TEXT   NOT NULL,
  committed_at     BIGINT NOT NULL,
  synced_at        BIGINT NOT NULL,
  synced_by        TEXT   NOT NULL,
  override_version BIGINT NOT NULL DEFAULT 0
);
