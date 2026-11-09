-- A persona defined by one agent.yaml.
--
-- personas.definition holds what that file adds beyond the existing columns:
-- `{ "description"?: string, "skills"?: string[], "guardrails"?: string[] }`.
-- NULL means the older layout (SOUL.md and extraction), which is every row
-- before this column. Non-NULL also says soul_json was compiled from the file,
-- not extracted, so nothing re-extracts it. Desired layer only: no override.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS definition JSONB;
