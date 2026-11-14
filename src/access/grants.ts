import { parseRef } from "../refs/parse";
import type { SoulData } from "../soul/data";
import { channelApproversOf, soulDataFor } from "../soul/per-persona";
import type { AgentGrantRow, GrantRole, SubjectKind } from "../db/agent-grants";

export type { GrantRole, SubjectKind };

/**
 * One effective grant on a persona. `source: "soul"` grants are derived in
 * memory from the persona's structured soul (read-only); `"console"` grants are
 * stored rows (agent_grants). `channelId` scopes an approver grant to one
 * channel (soul channel blocks only; stored grants are never channel scoped).
 */
export interface Grant {
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny: boolean;
  dmOnly: boolean;
  source: "soul" | "console";
  channelId?: string;
  id?: string;
  expiresAt?: number | null;
  /**
   * The typed Slack reference behind a user or channel subject (none for a
   * workspace grant). `workspace` is absent for a bare id or a short form;
   * `userId` is the internal user a stored grant resolved to. Read by the
   * internal-id path only; the legacy readers compare subjectKind and subjectId.
   */
  subject?: { service: "slack"; workspace?: string; userId?: string | null };
}

const soulGrant = (subjectKind: SubjectKind, subjectId: string, role: GrantRole, extra: Partial<Grant> = {}): Grant => ({
  subjectKind, subjectId, role, deny: false, dmOnly: false, source: "soul", ...extra,
});

/**
 * The workspace each Slack id was written with in agent.yaml (`accessEntries`).
 * An id written with two different workspaces has none. The legacy arrays
 * stay the source of the grants themselves, so this only adds `subject`.
 */
function writtenWorkspaces(soul: SoulData): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const e of soul.accessEntries ?? []) {
    const k = `${e.kind}:${e.id}`;
    const w = e.workspace ?? null;
    out.set(k, !out.has(k) || out.get(k) === w ? w : null);
  }
  return out;
}

/**
 * The soul mapping:
 *  - manager, backup manager -> user manager
 *  - global approvers -> user approver; each channel block's effective approvers
 *    (`channelApprovers`: replace semantics, manager and backup appended) ->
 *    user approver scoped to that channel. Approver is an approval right, not a
 *    chat right.
 *  - trusted and allowed channels -> channel member
 *  - DM allowlist -> user member, dm only
 *  - blocked users -> user deny
 */
export function deriveSoulGrants(soul: SoulData, channelApprovers: Map<string, string[]>): Grant[] {
  const out: Grant[] = [];
  const ws = writtenWorkspaces(soul);
  const ids = (xs: Array<string | undefined>): string[] => xs.filter((x): x is string => !!x);
  for (const id of ids([soul.manager.userId, soul.backupManager.userId])) out.push(soulGrant("user", id, "manager"));
  for (const id of ids(soul.approvers.map((a) => a.userId))) out.push(soulGrant("user", id, "approver"));
  for (const [channelId, users] of channelApprovers) {
    if (!channelId) continue;
    for (const id of ids(users)) out.push(soulGrant("user", id, "approver", { channelId }));
  }
  for (const c of ids([...soul.trustedChannels, ...soul.allowedChannels])) out.push(soulGrant("channel", c, "member"));
  for (const id of ids(soul.dmAllowedUsers)) out.push(soulGrant("user", id, "member", { dmOnly: true }));
  for (const id of ids(soul.blockedUsers)) out.push(soulGrant("user", id, "member", { deny: true }));
  return out.map((g) => {
    const w = ws.get(`${g.subjectKind}:${g.subjectId}`);
    return { ...g, subject: { service: "slack" as const, ...(w ? { workspace: w } : {}) } };
  });
}

/** A stored row as an effective grant. */
export function grantFromRow(r: AgentGrantRow): Grant {
  const g: Grant = {
    subjectKind: r.subjectKind, subjectId: r.subjectId, role: r.role, deny: r.deny, dmOnly: r.dmOnly,
    source: "console", id: r.id, expiresAt: r.expiresAt,
  };
  if (r.subjectKind === "workspace") return g;
  const parsed = r.subjectRef ? parseRef(r.subjectRef) : null;
  const workspace = parsed?.ok && parsed.ref.kind === "external" ? parsed.ref.workspace : undefined;
  return { ...g, subject: { service: "slack", ...(workspace ? { workspace } : {}), ...(r.subjectUserId ? { userId: r.subjectUserId } : {}) } };
}

/** Effective grants for a persona: soul-derived (from {@link soulDataFor}) plus stored. */
export function effectiveGrants(persona: string | null | undefined, stored: Grant[]): Grant[] {
  const soul = soulDataFor(persona);
  return [...deriveSoulGrants(soul, channelApproversOf(soul)), ...stored];
}
