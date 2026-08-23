-- Tenancy and persona registry (spec §4). Source of truth for multi-app
-- gateways; the monolith seeds a single 'default' tenant.

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at BIGINT NOT NULL
);

INSERT INTO tenants (id, name, status, created_at)
VALUES ('default', 'default', 'active', (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
ON CONFLICT (id) DO NOTHING;

-- One row per installed Slack app per workspace. Token + signing secret are
-- AES-256-GCM envelopes produced by src/db/crypto.ts, never plaintext.
CREATE TABLE IF NOT EXISTS slack_apps (
  api_app_id     TEXT NOT NULL,
  team_id        TEXT NOT NULL,
  tenant_id      TEXT NOT NULL REFERENCES tenants (id),
  persona_id     TEXT NOT NULL DEFAULT 'default',
  bot_token      TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  bot_user_id    TEXT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (api_app_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_apps_tenant ON slack_apps (tenant_id);

CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants (id),
  name          TEXT NOT NULL,
  soul_md       TEXT NOT NULL,
  soul_json     JSONB,
  soul_sha      TEXT,
  model_default TEXT,
  mcp_json      JSONB,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE (tenant_id, name)
);

-- Provider credentials (API key / OAuth token / base URL). persona_id NULL =
-- tenant-wide default. `value` is an encrypted envelope.
CREATE TABLE IF NOT EXISTS provider_creds (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants (id),
  persona_id TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('api_key', 'oauth_token', 'base_url')),
  value      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_creds_lookup
  ON provider_creds (tenant_id, persona_id, kind);
