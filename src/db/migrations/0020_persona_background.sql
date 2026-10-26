-- Per-persona background-learning settings.
--
-- personas.background holds the persona's `background` from the sync payload:
-- a JSON object `{ "budgetUsd": number, "timezone": "<IANA zone>" }`, either
-- key optional. NULL means the environment budget (SLAUDE_BACKGROUND_BUDGET_USD)
-- and UTC, which is the behaviour before this column. Desired layer only:
-- there is no override for it.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS background JSONB;
