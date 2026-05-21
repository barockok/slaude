import type { SoulData } from "../../soul/data";

/**
 * Authorisation gate for the /ingest command (Task 10).
 *
 * Returns true when `userId` matches one of:
 *   - the primary manager (`soulData.manager.userId`)
 *   - the backup manager (`soulData.backupManager.userId`)
 *   - any entry in the approvers list (`soulData.approvers[].userId`)
 *
 * All fields are optional in the SoulData schema (`.partial().default({})`),
 * so the function is defensive against missing data.
 */
export function canTriggerIngest(userId: string, soul: SoulData): boolean {
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  return false;
}
