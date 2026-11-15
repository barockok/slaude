-- Domain sessions, slice D (rc.22): channel_wake_state carries the boundary it belongs to.
-- Soft reference to boundaries.id (no foreign key), nullable, no default, no index.
-- Nothing reads these columns; the Slack columns stay authoritative and every
-- key stays as it was. lock_timeout makes a busy table fail this one file fast
-- instead of queuing writers behind the ALTER.
SET LOCAL lock_timeout = '2s';
ALTER TABLE channel_wake_state ADD COLUMN IF NOT EXISTS boundary_id TEXT;
