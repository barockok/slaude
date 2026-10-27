-- The heartbeat round (spec §10): a post keeps the text it sent and the
-- context it rested on (source, item, summary, rule, level, evidence) so a
-- reply or reaction can be read against what was actually said. Both are NULL
-- on a row written before this migration. context is JSON.
ALTER TABLE proactive_posts ADD COLUMN IF NOT EXISTS text TEXT;
ALTER TABLE proactive_posts ADD COLUMN IF NOT EXISTS context TEXT;

-- Per agent and source, how far the round has read (epoch ms). It only moves
-- forward: the next round asks a source for items newer than `since`.
CREATE TABLE IF NOT EXISTS heartbeat_watermarks (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  agent_id   TEXT   NOT NULL,
  source     TEXT   NOT NULL,
  since      BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, source)
);
