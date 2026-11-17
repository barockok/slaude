/**
 * Who may be read back out of a thread: one reusable filter for text the gateway fetches
 * from Slack and shows a model that was never sent it as a turn (the thread head today, a
 * classifier's recent messages later).
 *
 * It applies what the ingress applies to a person who writes to the agent, so reading someone
 * is never wider than hearing them: an author the persona's admission does not admit (denied,
 * or simply not granted here: the ingress drops both), a user or thread ignored, and the owner's
 * inbound deny rules on the text and on file names. The agent's own messages are always kept
 * (they are what it said, not input). The checks are injected, so the gateway wires the same
 * functions `preTurnDropReason` uses and a test wires fakes. An audit-only owner rule does
 * nothing here: only a deny hides a line.
 */
export type AuthorRef = { user?: string; bot_id?: string };

export type AuthorFilterDeps = {
  /** One of this persona's own identities. */
  isSelf: (m: AuthorRef) => boolean;
  /** The persona's admission lets this user in (the ingress drops everyone it does not admit). */
  isAdmitted: (userId: string) => Promise<boolean>;
  /** The user, or the thread, is ignored (the ingress's ignore gate). */
  isIgnored: (userId: string) => Promise<boolean>;
  /** The owner's inbound rules deny this text (also true when the rules cannot be read: fail closed). */
  textDenied: (text: string) => Promise<boolean>;
};

export type AuthorFilter = {
  /** Whether a message by this author may be shown. Never throws: an error is a refusal. */
  allows: (m: AuthorRef & { text?: string; files?: Array<{ name?: string; title?: string }> }) => Promise<boolean>;
};

export function makeAuthorFilter(d: AuthorFilterDeps): AuthorFilter {
  // One answer per user for the life of this filter (a filter lives for one read); calls may overlap.
  const answers: Record<string, Promise<boolean> | undefined> = Object.create(null);
  const userOk = (subject: string): Promise<boolean> =>
    (answers[subject] ??= (async () => (await d.isAdmitted(subject)) && !(await d.isIgnored(subject)))().catch(() => false));
  return {
    allows: async (m) => {
      try {
        if (d.isSelf(m)) return true;
        if (m.user && !(await userOk(m.user))) return false;
        const texts = [(m.text ?? "").toString(), ...(m.files ?? []).map((f) => (f.name || f.title || "").toString())];
        for (const t of texts) if (t && (await d.textDenied(t))) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
