-- Every proactive post (spec §10.4, §10.5): what the restraint rules count
-- (per-recipient daily cap, cooldown, "unchanged result posts nothing") and
-- what feedback finds a post by (its channel and message ts). recipient is a
-- user id (manager, person) or a channel id. text_hash is a hash of the
-- normalised text, never the text; evidence_hash the same for the evidence
-- the post rests on (a reworded post about the same evidence is unchanged).
-- Times are epoch ms.
CREATE TABLE IF NOT EXISTS proactive_posts (
  id          TEXT   PRIMARY KEY,
  tenant_id   TEXT   NOT NULL DEFAULT 'default',
  agent_id    TEXT   NOT NULL,
  audience    TEXT   NOT NULL,
  recipient   TEXT   NOT NULL,
  topic       TEXT   NOT NULL,
  text_hash   TEXT   NOT NULL,
  evidence_hash TEXT,
  channel_id  TEXT   NOT NULL,
  message_ts  TEXT,
  team_id     TEXT,
  posted_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proactive_posts_recipient ON proactive_posts (agent_id, recipient, posted_at);
CREATE INDEX IF NOT EXISTS idx_proactive_posts_message ON proactive_posts (channel_id, message_ts);
