-- The node label a persona runs on (node labels and routing spec §4.5). NULL
-- means `default`, which is also every sqlite and filesystem persona: they have
-- no row. Desired layer only: a runtime override can never set it, so git stays
-- the source of truth for where an agent runs. Postgres only, like personas.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS runs_on TEXT;

DO $$ BEGIN
  ALTER TABLE personas ADD CONSTRAINT personas_runs_on_chk
    CHECK (runs_on IS NULL OR runs_on ~ '^[a-z0-9][a-z0-9-]{0,31}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
