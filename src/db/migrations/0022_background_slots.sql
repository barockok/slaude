-- Claimed schedule slots of background learning passes (spec §9.1). The
-- background scheduler runs on one gateway replica at a time (leader loop),
-- but leadership can move mid-pass: before a pass starts, its slot is claimed
-- here with a plain INSERT, and a conflict means another scheduler already
-- took it, so a slot runs at most once across replicas and restarts. `slot` is
-- the persona-local period: YYYY-MM-DD for a daily pass, YYYY-Www (ISO week)
-- for a weekly one. claimed_at is epoch ms like every other table here.
CREATE TABLE IF NOT EXISTS background_slots (
  tenant_id   TEXT   NOT NULL DEFAULT 'default',
  agent_id    TEXT   NOT NULL,
  pass        TEXT   NOT NULL,
  slot        TEXT   NOT NULL,
  claimed_at  BIGINT NOT NULL,
  PRIMARY KEY (agent_id, pass, slot)
);
