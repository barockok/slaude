import { db } from "./schema";

/**
 * Skill usage per agent (spec §9.1; migration 0024): how often the agent
 * loaded each skill and when it last did. Written at turn time (best effort,
 * never on a turn's critical path), read by the weekly skill review.
 */
export interface SkillUsage {
  skill: string;
  uses: number;
  lastUsedAt: number | null;
  /** When tracking of this skill began (the row's first write). */
  firstSeenAt: number;
}

interface Row {
  skill: string;
  uses: number | string;
  last_used_at: number | string | null;
  first_seen_at: number | string;
}

const toUsage = (r: Row): SkillUsage => ({
  skill: r.skill,
  uses: Number(r.uses),
  lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  firstSeenAt: Number(r.first_seen_at),
});

/** Count one use of `skill` by `agentId` at `at`. last_used_at never moves backwards. */
export async function record(agentId: string, skill: string, at: number = Date.now()): Promise<void> {
  await db.run(
    `INSERT INTO skill_usage (agent_id, skill, uses, last_used_at, first_seen_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (agent_id, skill) DO UPDATE SET
       uses = skill_usage.uses + 1,
       last_used_at = CASE WHEN skill_usage.last_used_at IS NULL OR excluded.last_used_at > skill_usage.last_used_at
                           THEN excluded.last_used_at ELSE skill_usage.last_used_at END`,
    [agentId, skill, at, at],
  );
}

/**
 * Start tracking skills that have no row yet (uses 0, first seen `at`), so a
 * skill's unused time is measured from when it was first tracked. Existing
 * rows are left alone.
 */
export async function noteSeen(agentId: string, skills: readonly string[], at: number = Date.now()): Promise<void> {
  for (const skill of new Set(skills)) {
    await db.run(
      `INSERT INTO skill_usage (agent_id, skill, uses, last_used_at, first_seen_at)
       VALUES (?, ?, 0, NULL, ?)
       ON CONFLICT (agent_id, skill) DO NOTHING`,
      [agentId, skill, at],
    );
  }
}

/** One agent's usage rows, by skill. */
export async function forAgent(agentId: string): Promise<Map<string, SkillUsage>> {
  const rows = await db.query<Row>("SELECT skill, uses, last_used_at, first_seen_at FROM skill_usage WHERE agent_id = ?", [agentId]);
  return new Map(rows.map((r) => [r.skill, toUsage(r)]));
}

/**
 * Every agent's usage summed per skill (uses added, the latest last use, the
 * earliest first sighting): a skill in the shared base root is used by every
 * persona, so its review counts them all. Numbers only, never content.
 */
export async function allAgents(): Promise<Map<string, SkillUsage>> {
  const rows = await db.query<Row>(
    `SELECT skill, SUM(uses) AS uses, MAX(last_used_at) AS last_used_at, MIN(first_seen_at) AS first_seen_at
       FROM skill_usage GROUP BY skill`,
  );
  return new Map(rows.map((r) => [r.skill, toUsage(r)]));
}
