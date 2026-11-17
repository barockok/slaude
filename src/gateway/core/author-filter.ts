/**
 * Who may be read back out of a thread: one reusable filter for text the gateway fetches
 * from Slack and shows a model that was never sent it as a turn (the thread head today, a
 * classifier's recent messages later).
 *
 * It applies what the ingress applies to a person who writes to the agent, so reading someone
 * is never wider than hearing them: a user blocked for the persona, a user or thread ignored,
 * and the owner's inbound deny rules on the text. The agent's own messages are always kept
 * (they are what it said, not input). The checks are injected, so the gateway wires the same
 * functions `preTurnDropReason` uses and a test wires fakes.
 */
export type AuthorRef = { user?: string; bot_id?: string };

export type AuthorFilterDeps = {
  /** One of this deployment's own identities. */
  isSelf: (m: AuthorRef) => boolean;
  /** The user is denied for this persona (the ingress's `blocked_user`). */
  isBlocked: (userId: string) => Promise<boolean>;
  /** The user, or the thread, is ignored (the ingress's ignore gate). */
  isIgnored: (userId: string) => Promise<boolean>;
  /** The owner's inbound rules deny this text (also true when the rules cannot be read: fail closed). */
  textDenied: (text: string) => Promise<boolean>;
};

export type AuthorFilter = {
  /** Whether a message by this author with this text may be shown. Never throws: an error is a refusal. */
  allows: (m: AuthorRef & { text?: string }) => Promise<boolean>;
};

export function makeAuthorFilter(d: AuthorFilterDeps): AuthorFilter {
  // One answer per user for the life of this filter (a filter lives for one read; its calls run in turn).
  const byUser = new Map<string, boolean>();
  const userOk = async (userId: string): Promise<boolean> => {
    const known = byUser.get(userId);
    if (known !== undefined) return known;
    let ok: boolean;
    try {
      ok = !(await d.isBlocked(userId)) && !(await d.isIgnored(userId));
    } catch {
      ok = false;
    }
    byUser.set(userId, ok);
    return ok;
  };
  return {
    allows: async (m) => {
      try {
        if (d.isSelf(m)) return true;
        if (m.user && !(await userOk(m.user))) return false;
        const text = (m.text ?? "").toString();
        if (text && (await d.textDenied(text))) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
