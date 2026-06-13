import type { SoulData } from "../../soul/data";

/**
 * Authorisation gate for the /model command: primary manager, backup manager,
 * any approver, or any DM-allowed user (`dmAllowedUsers`).
 *
 * Note: `dmAllowedUsers` does NOT confer manager authority on the other admin
 * commands (cron / ignore / ingest). `/model` intentionally widens the gate to
 * the DM allowlist — per-thread model choice is low-risk and self-scoped.
 * Defensive against missing soul fields (all optional in the schema).
 */
export function canChangeModel(userId: string, soul: SoulData): boolean {
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  if (soul.dmAllowedUsers?.includes(userId)) return true;
  return false;
}
