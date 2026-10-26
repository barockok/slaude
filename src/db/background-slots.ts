import { db } from "./schema";

/**
 * Claim one schedule slot of a background pass for an agent: a plain INSERT,
 * where a conflict (the slot was already claimed, by this or another
 * scheduler) returns false. Claimed before the pass starts, so a leader that
 * dies mid-pass never has its slot re-run by the next one.
 */
export async function claimSlot(agentId: string, pass: string, slot: string, at: number = Date.now()): Promise<boolean> {
  const res = await db.run(
    `INSERT INTO background_slots (agent_id, pass, slot, claimed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, pass, slot) DO NOTHING`,
    [agentId, pass, slot, at],
  );
  return res.changes > 0;
}

/** Store what a claimed slot carries to the pass's next period (migration 0025). */
export async function setSlotState(agentId: string, pass: string, slot: string, state: string): Promise<void> {
  await db.run("UPDATE background_slots SET state = ? WHERE agent_id = ? AND pass = ? AND slot = ?", [state, agentId, pass, slot]);
}

/**
 * The state of the pass's latest slot before `beforeSlot` that has one, or
 * null. Slots compare as text: YYYY-MM-DD and YYYY-Www both sort in time order.
 */
export async function previousSlotState(agentId: string, pass: string, beforeSlot: string): Promise<{ slot: string; state: string } | null> {
  const row = await db.one<{ slot: string; state: string }>(
    `SELECT slot, state FROM background_slots
      WHERE agent_id = ? AND pass = ? AND slot < ? AND state IS NOT NULL
      ORDER BY slot DESC LIMIT 1`,
    [agentId, pass, beforeSlot],
  );
  return row ? { slot: row.slot, state: row.state } : null;
}

/** When a slot was claimed (epoch ms), or null when it is not. */
export async function claimedAt(agentId: string, pass: string, slot: string): Promise<number | null> {
  const row = await db.one<{ claimed_at: number | string }>(
    `SELECT claimed_at FROM background_slots WHERE agent_id = ? AND pass = ? AND slot = ?`,
    [agentId, pass, slot],
  );
  return row ? Number(row.claimed_at) : null;
}
