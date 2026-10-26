-- Skill usage for the weekly skill review (spec §9.1). One row per agent and
-- skill: how often the agent loaded it (a successful `Skill` tool call, or a
-- `/<slug>` invocation in Slack) and when it last did. agent_id is the
-- persona's agent id (the `agent-<id>` slice and ledger key); skill is the
-- name as invoked, normalised (no leading "/", the $SLAUDE_HOME plugin's
-- prefix removed; built-ins keep `slaude:`).
--
-- first_seen_at is when this row began: a skill counts as unused for N days
-- only once its usage has been tracked for N days, so a fresh install (or a
-- database that lost its counts) never reads as "never used". Timestamps are
-- epoch ms like every other table here.
CREATE TABLE IF NOT EXISTS skill_usage (
  agent_id       TEXT   NOT NULL,
  skill          TEXT   NOT NULL,
  tenant_id      TEXT   NOT NULL DEFAULT 'default',
  uses           BIGINT NOT NULL DEFAULT 0,
  last_used_at   BIGINT,
  first_seen_at  BIGINT NOT NULL,
  PRIMARY KEY (agent_id, skill)
);
