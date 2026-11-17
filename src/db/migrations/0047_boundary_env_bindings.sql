-- Domain sessions, slice D (rc.22): env_bindings carries the boundary it belongs to.
-- Soft reference to boundaries.id (no foreign key), nullable, no default, no index.
-- Nothing reads these columns; the Slack columns stay authoritative and every
-- key stays as it was. lock_timeout makes a busy table fail this one file fast
-- instead of queuing writers behind the ALTER.
SET LOCAL lock_timeout = '2s';
ALTER TABLE env_bindings ADD COLUMN IF NOT EXISTS boundary_id TEXT;
ALTER TABLE env_bindings ADD COLUMN IF NOT EXISTS locator TEXT;
