-- Thread head (rc.28): the time the session's thread head was claimed for a turn's prompt.
-- Nullable, no default, no index. NULL means the head has not been given yet; the gateway
-- sets it with UPDATE ... WHERE thread_head_at IS NULL and reads the changed-row count, so
-- two quick first messages cannot both inject it and a thread first seen as a suppressed
-- recording still gets its head on its first real turn. An rc.27 binary never names the
-- column and keeps writing.
--
-- A session that already ran a turn before this release must not get a head in the middle of
-- its conversation, so the rows with claude_started = 1 are marked as claimed (at their creation
-- time). A row that never started keeps NULL: its first real turn is still ahead. lock_timeout makes a busy table fail this one file fast
-- instead of queuing writers behind the ALTER.
SET LOCAL lock_timeout = '2s';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thread_head_at BIGINT;
UPDATE sessions SET thread_head_at = created_at WHERE claude_started = 1 AND thread_head_at IS NULL;
