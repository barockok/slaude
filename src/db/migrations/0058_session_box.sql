-- The box a session is pinned to: its name and its image digest. Both nullable, no default, no
-- index. NULL means the session is not boxed (or not pinned yet); the gateway pins both at the
-- first dispatch with UPDATE ... WHERE box_digest IS NULL and reads the row back, so two quick
-- first messages cannot pin different digests. A session never moves on its own: a later box
-- version changes new sessions only. An older binary never names the columns and keeps writing.
-- lock_timeout makes a busy table fail this one file fast instead of queuing writers behind the ALTER.
SET LOCAL lock_timeout = '2s';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS box_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS box_digest TEXT;
