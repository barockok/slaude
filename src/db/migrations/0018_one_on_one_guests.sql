-- /1on1 named guests.
--
-- one_on_one_locks.guests holds the Slack user ids the owner invited into a
-- LOCKED 1on1 (`/1on1 invite`), as a JSON array in TEXT (sqlite mirrors it as
-- TEXT too). NULL means no guests: every existing row keeps today's behaviour,
-- where only the owner and the manager/backup are heard. Guests never change
-- whose identity the session runs as. Re-locking, opening or releasing the
-- 1on1 clears the column.
ALTER TABLE one_on_one_locks ADD COLUMN IF NOT EXISTS guests TEXT;
