/**
 * Memory places registry (migration 0054): one row per (agent, boundary) place source.
 *
 * This module only stores and reads rows. It never builds a source id: the id is made by
 * `placeSourceId` in src/memory/place.ts and passed in, so the naming has one home.
 * `boundary_id` is a soft reference to boundaries.id (no foreign key).
 */
import { db, type DbClient } from "./schema";

export interface MemoryScopeRow {
  source_id: string;
  agent_id: string;
  boundary_id: string;
  kind: string;
  created_at: number;
}

interface Raw {
  source_id: string;
  agent_id: string;
  boundary_id: string;
  kind: string;
  created_at: number | string;
}

const toRow = (r: Raw): MemoryScopeRow => ({ ...r, created_at: Number(r.created_at) });

/**
 * Bind a place source to (agent, boundary), insert-or-ignore, and return the source id the
 * registry holds for that pair. An existing row wins, so replicas that race agree on one id;
 * the unique key is (agent_id, boundary_id), so a pair never has two sources.
 */
export async function bindScope(
  i: { sourceId: string; agentId: string; boundaryId: string; kind: string; now?: number },
  c: DbClient = db,
): Promise<string> {
  await c.run(
    `INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [i.sourceId, i.agentId, i.boundaryId, i.kind, i.now ?? Date.now()],
  );
  const row = await c.one<{ source_id: string }>("SELECT source_id FROM memory_scopes WHERE agent_id = ? AND boundary_id = ?", [i.agentId, i.boundaryId]);
  if (!row) throw new Error("memory scope bind lost the row");
  return row.source_id;
}

/** Every place of one agent, oldest first. */
export async function listByAgent(agentId: string, c: DbClient = db): Promise<MemoryScopeRow[]> {
  const rows = await c.query<Raw>("SELECT source_id, agent_id, boundary_id, kind, created_at FROM memory_scopes WHERE agent_id = ? ORDER BY created_at, source_id", [agentId]);
  return rows.map(toRow);
}

/** The registry row of a source, or null. */
export async function lookupBySource(sourceId: string, c: DbClient = db): Promise<MemoryScopeRow | null> {
  const row = await c.one<Raw>("SELECT source_id, agent_id, boundary_id, kind, created_at FROM memory_scopes WHERE source_id = ?", [sourceId]);
  return row ? toRow(row) : null;
}

/** True when the registry holds any row. */
export async function anyBound(c: DbClient = db): Promise<boolean> {
  return (await c.one<{ x: number }>("SELECT 1 AS x FROM memory_scopes LIMIT 1")) !== null;
}
