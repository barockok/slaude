-- The brain (gbrain) gets its own database on the same Postgres server.
--
-- gbrain creates roughly seventy tables, several with generic names such as
-- config, files, sources and oauth_tokens. None collide with slaude's tables
-- today, but sharing one database would make every future slaude migration a
-- potential collision, so the two schemas evolve apart.
--
-- A gateway may not run the brain on its embedded PGLite engine (it is
-- single-writer), so SLAUDE_BRAIN_ENGINE=postgres points it here.
--
-- Runs only when the Postgres data directory is first initialised.
CREATE DATABASE slaude_brain;

\connect slaude_brain

-- gbrain also runs these itself, but only a sufficiently privileged role can.
-- Creating them here lets the brain connect as an ordinary application role.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
