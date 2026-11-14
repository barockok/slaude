import { loadGrants } from "./role";
import { roleAt, sameAt } from "./wired";

export interface PermissionDeciderArgs {
  /** Slack user who clicked the card. */
  clicker: string;
  /** Slack user who started the turn; null for a turn with no human
   *  initiator (panel, cron, heartbeat, background) and for a row written
   *  before the initiator was stamped. */
  initiator: string | null;
  /** The thread's /1on1 lock owner, or null when the thread is not locked. */
  lockOwner: string | null;
  /** Persona NAME the card belongs to (gate row `personaName`); null is the
   *  default persona. */
  persona: string | null;
  /** Channel the card was posted in. */
  channel: string | null;
  /** The workspace the click came from, when the caller knows it. Used only
   *  by the shadow of the internal-id path; the answer never depends on it. */
  teamId?: string | null;
  /** The workspace the lock was taken in (null for a lock written before it was recorded). */
  lockTeamId?: string | null;
}

/**
 * Who may decide a tool permission card: the person who started the turn,
 * the thread's /1on1 lock owner, or an approver or manager of the persona
 * (channel-aware). A turn with no initiator therefore needs an approver or a
 * manager. The role is `roleOf` over the persona's effective grants (its own
 * soul with per-unit fallback, plus stored grants), so approvers are
 * channel-aware with replace semantics. The three comparisons run through the
 * shadow seam (slice C task 14) and still return the string answer.
 */
export async function canDecidePermission(a: PermissionDeciderArgs): Promise<boolean> {
  if (!a.clicker) return false;
  const seam = { persona: a.persona, teamId: a.teamId, userId: a.clicker };
  if (a.initiator && (await sameAt({ ...seam, site: "permission.initiator_same", otherUserId: a.initiator }))) return true;
  if (a.lockOwner && (await sameAt({ ...seam, site: "permission.lock_owner_same", otherUserId: a.lockOwner, otherTeamId: a.lockTeamId }))) return true;
  const role = (await roleAt({ ...seam, site: "permission.role", channelId: a.channel, grants: await loadGrants(a.persona) }));
  return role === "approver" || role === "manager";
}
