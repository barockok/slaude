-- A parked paste-back /mcp connect, waiting for the initiator to paste the
-- callback into the thread.
--
-- It lived in a per-process Map, which works with one gateway and not with two:
-- the pasted URL arrives on whichever replica took that Slack event, and a
-- replica that did not start the flow knows nothing about it. Phase 4 solved the
-- same problem for the portal; this is the Slack side of it.
--
-- Keyed on channel:thread:user — the same binding the Map used, and what makes a
-- bystander's paste land on a different key and find nothing.
--
-- payload is AES-256-GCM (src/db/crypto.ts) over the PKCE verifier, the
-- registered client id and secret, the pinned token endpoint, and the routing
-- the completion needs. No owner column: whose credential this becomes is
-- decided at completion from the scope and the Slack user, exactly as before.
CREATE TABLE IF NOT EXISTS slack_oauth_flows (
  flow_key   TEXT   PRIMARY KEY,
  payload    TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_oauth_flows_expires ON slack_oauth_flows (expires_at);
