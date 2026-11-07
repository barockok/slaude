import { roleOf } from "./role";

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
}

/**
 * Who may decide a tool permission card: the person who started the turn,
 * the thread's /1on1 lock owner, or an approver or manager of the persona
 * (channel-aware). A turn with no initiator therefore needs an approver or a
 * manager. The role is `roleOf` over the persona's effective grants (its own
 * soul with per-unit fallback, plus stored grants), so approvers are
 * channel-aware with replace semantics.
 */
export async function canDecidePermission(a: PermissionDeciderArgs): Promise<boolean> {
  if (!a.clicker) return false;
  if (a.initiator && a.clicker === a.initiator) return true;
  if (a.lockOwner && a.clicker === a.lockOwner) return true;
  const role = await roleOf(a.persona, a.clicker, a.channel);
  return role === "approver" || role === "manager";
}
