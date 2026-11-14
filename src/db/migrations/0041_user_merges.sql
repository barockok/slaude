-- Merge engine (slice C, rc.21): the ledger of user merges, the proposals a
-- human settles, and the vetoes an undo leaves behind. Additive: nothing else
-- reads or writes these tables.
--
-- Deployment-global like users and bindings. survivor_id and loser_id carry no
-- foreign key on purpose: the loser row is deleted by the merge, and the ledger
-- must outlive both records (it is the undo authority, D14). JSON columns are
-- TEXT holding JSON, so both dialects read and write them the same way.
CREATE TABLE IF NOT EXISTS user_merges (
  id             TEXT   PRIMARY KEY,
  created_at     BIGINT NOT NULL,
  kind           TEXT   NOT NULL,
  survivor_id    TEXT   NOT NULL,
  loser_id       TEXT   NOT NULL,
  state          TEXT   NOT NULL DEFAULT 'applied',
  actor          TEXT   NOT NULL DEFAULT '',
  proof          TEXT   NOT NULL DEFAULT '{}',
  moved          TEXT   NOT NULL DEFAULT '{}',
  audit_event_id TEXT,
  undo_until     BIGINT NOT NULL,
  undone_at      BIGINT,
  undone_by      TEXT,
  notice_state   TEXT   NOT NULL DEFAULT 'pending',
  CHECK (kind IN ('proof', 'console')),
  CHECK (state IN ('applied', 'undone')),
  CHECK (notice_state IN ('pending', 'sent', 'failed', 'skipped')),
  CHECK (survivor_id <> loser_id)
);
-- A loser id is merged away once while the merge stands; an undone merge frees it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_merges_loser_applied ON user_merges (loser_id) WHERE state = 'applied';
CREATE INDEX IF NOT EXISTS idx_user_merges_survivor ON user_merges (survivor_id);

-- A pair a human settles. The code stores the pair in id order (JS string
-- order; no CHECK on the order, a database collation could disagree), so
-- (a, b) and (b, a) are one row.
CREATE TABLE IF NOT EXISTS merge_proposals (
  id          TEXT   PRIMARY KEY,
  created_at  BIGINT NOT NULL,
  user_a      TEXT   NOT NULL,
  user_b      TEXT   NOT NULL,
  reason      TEXT   NOT NULL,
  state       TEXT   NOT NULL DEFAULT 'open',
  evidence    TEXT   NOT NULL DEFAULT '{}',
  resolved_by TEXT,
  resolved_at BIGINT,
  UNIQUE (user_a, user_b, reason),
  CHECK (reason IN ('conflict', 'two-emails')),
  CHECK (state IN ('open', 'dismissed', 'merged')),
  CHECK (user_a <> user_b)
);
CREATE INDEX IF NOT EXISTS idx_merge_proposals_state ON merge_proposals (state);

-- Undo of a proof merge forbids the same (Slack binding, account) pair from
-- linking again until an operator lifts the veto. Keyed on the oidc binding of
-- the account, never on an email binding.
CREATE TABLE IF NOT EXISTS merge_vetoes (
  id               TEXT   PRIMARY KEY,
  slack_binding_id TEXT   NOT NULL,
  oidc_binding_id  TEXT   NOT NULL,
  created_by       TEXT   NOT NULL,
  created_at       BIGINT NOT NULL,
  merge_id         TEXT,
  UNIQUE (slack_binding_id, oidc_binding_id)
);
