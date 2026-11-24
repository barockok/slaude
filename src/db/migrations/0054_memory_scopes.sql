-- Memory places registry (rc.45). One row per (agent, boundary) place source, written
-- insert-or-ignore before the first write to that source. It gives the reverse lookup
-- (source to boundary), the list of places for passes and the console, and the binding a
-- later release checks in SQL. Additive: nothing reads or writes this table in rc.45
-- except the measuring code, and no existing table changes.
--
-- boundary_id is a soft reference to boundaries.id (no foreign key), like every other
-- boundary_id column, so a row never blocks a boundary change. source_id is the gbrain
-- source name (`mb-` plus 28 hex characters, built only by src/memory/place.ts). A new
-- table takes no lock on a live one; lock_timeout keeps this one file from queuing behind
-- a long transaction.
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS memory_scopes (
  source_id   TEXT   PRIMARY KEY,
  agent_id    TEXT   NOT NULL,
  boundary_id TEXT   NOT NULL,
  kind        TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  UNIQUE (agent_id, boundary_id)
);
