import type { SoulData } from "../../soul/data";

/**
 * Authorisation gate for the /model command. Same predicate as
 * /ingest, /cron, /ignore: primary manager, backup manager, or any approver.
 * Defensive against missing soul fields (all optional in the schema).
 */
export function canChangeModel(userId: string, soul: SoulData): boolean {
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  return false;
}
