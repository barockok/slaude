-- Which process minted a pending gate. A replica may only treat a row as its
-- own orphan when the instance id matches its boot-time id; a foreign pending
-- row without a local waiter belongs to a (possibly live) sibling replica and
-- must never be click-cancelled — true orphans drain via expires_at instead.
-- Nullable: rows minted before this column exist only in pre-upgrade DBs.

ALTER TABLE pending_gates ADD COLUMN IF NOT EXISTS instance_id TEXT;
