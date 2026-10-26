-- Per-thread turn activity for the quiet-moment pass (spec §9.1, §8.5). One
-- row per session, bumped at turn end where the gateway sees a turn's memory
-- sync (the /v1 memory route for node turns, mono's scoped memory provider);
-- a database write only, never a brain call on the turn path.
--
-- agent_id is the persona's agent id (the `agent-<id>` slice and ledger key).
-- scope is whose memory the thread's conversation page is kept in, by the same
-- rule memory sync uses: 'agent' for the agent's own slice, 'user:<id>' for a
-- person's (/1on1 or DM). A turn in a different scope restarts the count.
-- turns counts the thread's turns in that scope; last_turn_at and
-- summarized_at are epoch ms like every other table here (summarized_at is
-- the last_turn_at a summary was written through, NULL before the first).
CREATE TABLE IF NOT EXISTS thread_activity (
  session_id     TEXT   PRIMARY KEY,
  tenant_id      TEXT   NOT NULL DEFAULT 'default',
  agent_id       TEXT   NOT NULL,
  turns          INT    NOT NULL DEFAULT 0,
  last_turn_at   BIGINT NOT NULL,
  summarized_at  BIGINT,
  scope          TEXT   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_activity_agent ON thread_activity (agent_id, last_turn_at);
