import { effectiveSoulForChannel, soulData } from "../soul/extract";

export type InterimRole = "manager" | "approver" | "member";

/**
 * Interim role check for the permission card, read from the default soul.
 * The real `roleOf()` (src/access/role.ts, per-persona grants) replaces this;
 * until then every persona is judged against the default SOUL.md, so
 * `persona` is accepted but not used.
 *
 *  - manager or backup manager -> "manager"
 *  - a global approver, or an approver of the channel's effective soul
 *    (whose override list already carries manager and backup) -> "approver"
 *  - anyone else -> "member"
 */
export function interimRoleOf(_persona: string | null | undefined, user: string, channel?: string | null): InterimRole {
  if (!user) return "member";
  const soul = soulData();
  if (user === soul.manager?.userId || user === soul.backupManager?.userId) return "manager";
  if (soul.approvers.some((a) => a.userId === user)) return "approver";
  if (channel && effectiveSoulForChannel(channel).approvers.some((a) => a.userId === user)) return "approver";
  return "member";
}
