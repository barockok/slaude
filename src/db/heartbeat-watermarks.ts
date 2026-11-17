import { db } from "./schema";

/**
 * How far the heartbeat round has read each source, per agent (migration
 * 0030). Times are epoch ms. Database only.
 */

/** The agent's watermark for a source, or null when it has none yet. */
export async function getSince(agentId: string, source: string): Promise<number | null> {
  const row = await db.one<{ since: number | string }>(
    `SELECT since FROM heartbeat_watermarks WHERE agent_id = ? AND source = ?`,
    [agentId, source],
  );
  return row ? Number(row.since) : null;
}

/** Move the watermark to `since`; an earlier value never moves it back. */
export async function advance(agentId: string, source: string, since: number, now: number): Promise<void> {
  await db.run(
    `INSERT INTO heartbeat_watermarks (agent_id, source, since, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, source) DO UPDATE SET
       since = CASE WHEN excluded.since > heartbeat_watermarks.since THEN excluded.since ELSE heartbeat_watermarks.since END,
       updated_at = excluded.updated_at`,
    [agentId, source, since, now],
  );
}
