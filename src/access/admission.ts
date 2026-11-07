import type { Grant } from "./grants";

export type AdmitResult = { ok: true } | { ok: false; reason: "blocked_user" | "whitelist" };

/**
 * Whether a message from `userId` in `channelId` reaches persona P, over P's
 * effective grants. Pure. In order:
 *
 *  1. a deny for the user -> drop (`blocked_user`);
 *  2. the user holds manager -> admit;
 *  3. a DM: admit when the user holds a member grant (soul dm-only or stored).
 *     Approver alone does not admit;
 *  4. not a DM: admit when the channel has a grant, or the user holds a STORED
 *     member grant that is not dm-only, or a workspace grant exists;
 *  5. otherwise drop (`whitelist`, the existing metric label).
 *
 * With soul-derived grants only, this is the old channel-mode rule plus the
 * blocklist. Stored grants only widen (member, workspace) or narrow (deny).
 *
 * `grants`: the persona's effective grants, i.e. `loadGrants(personaName)`
 * from ./role (keyed by persona NAME, not id). `isDM`: Slack channel_type
 * "im" only; a group DM ("mpim") counts as a channel, as today.
 */
export function admit(o: { grants: readonly Grant[]; userId: string; channelId: string; isDM: boolean }): AdmitResult {
  const mine = o.grants.filter((g) => g.subjectKind === "user" && g.subjectId === o.userId);
  if (mine.some((g) => g.deny)) return { ok: false, reason: "blocked_user" };
  const live = mine.filter((g) => !g.deny);
  if (live.some((g) => g.role === "manager")) return { ok: true };
  if (o.isDM) {
    return live.some((g) => g.role === "member") ? { ok: true } : { ok: false, reason: "whitelist" };
  }
  const channel = o.grants.some((g) => !g.deny && g.subjectKind === "channel" && g.subjectId === o.channelId);
  const storedMember = live.some((g) => g.source === "console" && g.role === "member" && !g.dmOnly);
  const workspace = o.grants.some((g) => !g.deny && g.subjectKind === "workspace");
  return channel || storedMember || workspace ? { ok: true } : { ok: false, reason: "whitelist" };
}
