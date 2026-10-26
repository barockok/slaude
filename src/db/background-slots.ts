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
