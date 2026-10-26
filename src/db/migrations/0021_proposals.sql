-- Proposals from background learning passes (spec §9.1 "Approvals in
-- background passes"). A pass never calls a carded or mutating tool: anything
-- that would need a card (a shared team fact, promoting /1on1 content, a
-- skill removal, a lesson promoted into the SOUL) is queued here and later
-- delivered as a card, to the manager in the weekly digest or to the person in
-- their DM. Nothing is written until the card is approved; an open row past
-- expires_at (created_at + 14 days) is expired.
--
-- to_kind is 'manager' or 'person'; to_user is the person's Slack user id when
-- to_kind = 'person'. scope is 'agent' or 'user:<id>' (the pass that proposed
-- it), never content. Timestamps are epoch ms like every other table here.
CREATE TABLE IF NOT EXISTS proposals (
  id          TEXT   PRIMARY KEY,
  tenant_id   TEXT   NOT NULL DEFAULT 'default',
  agent_id    TEXT   NOT NULL,
  -- team-fact | promote | skill-removal | lesson-promotion
  kind        TEXT   NOT NULL,
  to_kind     TEXT   NOT NULL,
  to_user     TEXT,
  scope       TEXT   NOT NULL,
  payload     JSONB  NOT NULL DEFAULT '{}'::jsonb,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  -- open | approved | rejected | expired
  status      TEXT   NOT NULL DEFAULT 'open',
  decided_by  TEXT,
  decided_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_proposals_agent_status ON proposals (agent_id, status);
