-- End-user accounts and their Slack bindings (phase 2 identity).
--
-- An account is a local projection of an external identity: the identity
-- provider owns authentication, we own the one thing it cannot give us, which
-- is which Slack user this person is.

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  issuer     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (issuer, subject)
);

-- (team_id, slack_user_id) is the PRIMARY KEY, so one Slack identity binds to
-- exactly one account. That uniqueness is what makes a replayed onboarding link
-- a no-op or a rejection rather than a takeover. An account may appear here
-- more than once: one person, several workspaces.
CREATE TABLE IF NOT EXISTS slack_identities (
  team_id       TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at     BIGINT NOT NULL,
  linked_via    TEXT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_identities_account
  ON slack_identities (account_id);
