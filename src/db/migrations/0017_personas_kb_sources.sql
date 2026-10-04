-- Per-persona knowledge scope (WS-C §4.1).
--
-- personas.kb_sources holds the persona's `kbSources` from the sync payload: a
-- JSON array of knowledge-base source ids (`kb-<label>`). NULL means every
-- installed KB (the behaviour before this column, so existing rows change
-- nothing); [] means none. It filters only the kb-* sources: the caller's own
-- slice, shared, public and the legacy agent source keep their own rules.
-- Desired layer only: there is no override for it.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS kb_sources JSONB;
