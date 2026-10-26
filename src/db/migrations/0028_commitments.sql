-- Open commitments, indexed for the promise scheduler (spec §10.1). The brain
-- page (type commitment) is the truth; this row mirrors one open page with a
-- machine-readable next check so the scheduler never scans brain pages on a
-- timer. Written after a commitment page is written (kb_memoize, a pass's
-- memoize); a done/dropped page that supersedes it closes the row.
--
-- source/slug name the page. run_as is the user id when the page lives in
-- that person's `user-<id>` slice (a /1on1 promise), else NULL. team_id is
-- the writing turn's Slack team when known. due_kind is 'time' (checked once
-- at its time) or 'event' (polled until expires_at). Times are epoch ms.
-- status: open | done | dropped | expired.
CREATE TABLE IF NOT EXISTS commitments (
  agent_id         TEXT   NOT NULL,
  source           TEXT   NOT NULL,
  slug             TEXT   NOT NULL,
  tenant_id        TEXT   NOT NULL DEFAULT 'default',
  persona_id       TEXT   NOT NULL DEFAULT 'default',
  team_id          TEXT,
  channel_id       TEXT   NOT NULL,
  thread_ts        TEXT   NOT NULL,
  beneficiary      TEXT   NOT NULL,
  run_as           TEXT,
  due_text         TEXT   NOT NULL,
  due_kind         TEXT   NOT NULL,
  check_text       TEXT   NOT NULL DEFAULT '',
  on_no_change     TEXT   NOT NULL DEFAULT 'silent',
  next_check_at    BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  status           TEXT   NOT NULL DEFAULT 'open',
  checks           INT    NOT NULL DEFAULT 0,
  last_checked_at  BIGINT,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (agent_id, source, slug)
);

CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments (agent_id, status, next_check_at);
