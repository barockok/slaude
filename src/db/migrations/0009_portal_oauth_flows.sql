-- One in-flight portal OAuth authorization, for at most a few minutes.
--
-- The portal's connect flow cannot keep its state in the browser the way the
-- panel's login does: finishing an MCP connect needs the client secret issued
-- by dynamic registration, and a signed cookie's payload is base64, readable by
-- anyone holding the cookie. So the state rests here and the cookie carries
-- only this row's opaque id.
--
-- payload is AES-256-GCM (src/db/crypto.ts) over the client id, client secret,
-- PKCE verifier, token endpoint, server name and URL, and the OAuth state. The
-- row is single use: the callback deletes it as it reads it, so a replayed
-- callback finds nothing. expires_at is plaintext only so the sweep can run
-- without decrypting.
CREATE TABLE IF NOT EXISTS portal_oauth_flows (
  id         TEXT   PRIMARY KEY,
  account_id TEXT   NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  payload    TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_oauth_flows_expires ON portal_oauth_flows (expires_at);
