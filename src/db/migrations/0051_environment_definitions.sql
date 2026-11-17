-- Environment definitions (slice E, rc.24): a shared ssh machine declared in
-- the deploy repository and synced into the gateway. Additive only: a personal
-- row keeps source 'user' and NULL in every other new column, and the old
-- INSERT shape keeps working. Do not drop these columns on a rollback.
--
-- A definition row has tenant_id = the tenant, a tenant-qualified id, and a
-- team_id of 'def~<tenant>' (no Slack team id contains '~'), so it can never
-- collide with a personal row or with another tenant's row of the same name.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE environments ADD COLUMN IF NOT EXISTS definition_name TEXT;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS definition_hash TEXT;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS definition_revision TEXT;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS retired_at BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_definition
  ON environments (tenant_id, definition_name) WHERE definition_name IS NOT NULL;
