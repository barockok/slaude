-- Access on internal ids (slice C, rc.19): schema only, additive and nullable.
-- Nothing reads the new columns for a decision yet; subject_kind and
-- subject_id stay authoritative for grants.
--
-- agent_grants: a grant can name a reference and the user it resolved to.
-- one_on_one_locks: a Slack id is only unique in a workspace, so a lock
-- records its team (old rows stay NULL and are read as unknown).
-- accounts: email_proven is set when the login token carried
-- email_verified === true and a real email claim; only then does the login
-- project a verified email binding.
-- link_token_uses: single-use ledger for the portal link token (the jti), so
-- unlinking cannot make the same token valid again within its lifetime.
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS subject_ref TEXT;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS subject_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_grants_subject_user ON agent_grants (subject_user_id);

ALTER TABLE one_on_one_locks ADD COLUMN IF NOT EXISTS team_id TEXT;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_proven BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS link_token_uses (
  jti           TEXT   PRIMARY KEY,
  team_id       TEXT   NOT NULL,
  slack_user_id TEXT   NOT NULL,
  used_at       BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_token_uses_expires ON link_token_uses (expires_at);
