-- Persona provider credentials by reference (WS-A §4, §10).
--
-- personas.provider_json holds the persona's `provider` object from the sync
-- payload: vault:// and env:// REFERENCES (and an optional literal base URL),
-- never a credential value. Values are resolved by the gateway at runtime-bundle
-- build and are never stored. Desired layer only: there is no override for it.
--
-- provider_creds gains the auth_token kind (ANTHROPIC_AUTH_TOKEN), so the
-- implicit read-only fallback can carry every field a reference can.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS provider_json JSONB;

ALTER TABLE provider_creds DROP CONSTRAINT IF EXISTS provider_creds_kind_check;
ALTER TABLE provider_creds ADD CONSTRAINT provider_creds_kind_check
  CHECK (kind IN ('api_key', 'oauth_token', 'base_url', 'auth_token'));
