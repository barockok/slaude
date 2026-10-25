/**
 * Mono turn senders (phase C, invariant 2): who sent the messages a
 * session's running turn holds. The gateway notes each message (Slack,
 * panel, cron) as it is delivered and ends the record when the turn ends.
 * The route's ctx is rewritten by every delivery, so it alone cannot tell
 * Alice's turn with Bob's message merged in from Bob's own turn; a profile
 * write needs this record to be exactly the speaker from Slack.
 *
 * A message delivered while a turn runs that the CLI then runs as its own
 * turn loses its record when the first turn ends, so a profile write in it is
 * refused (fail closed, the next message starts a fresh record).
 */
import type { TurnSender } from "../../knowledge/gated-dispatch";

export class TurnSenderLog {
  #bySession = new Map<string, TurnSender[]>();

  /** Record one delivered message's sender (deduplicated). No user id: nothing to record. */
  note(sessionId: string, m: { userId?: string | null; teamId?: string | null; origin?: string | null }): void {
    if (!m.userId) return;
    const s: TurnSender = { userId: m.userId, teamId: m.teamId || null, origin: m.origin ?? null };
    const list = this.#bySession.get(sessionId) ?? [];
    if (!list.some((x) => x.userId === s.userId && x.teamId === s.teamId && x.origin === s.origin)) list.push(s);
    this.#bySession.set(sessionId, list);
  }

  /** The running turn's senders, or null when none were recorded. */
  get(sessionId: string): readonly TurnSender[] | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /** The turn ended (done or error): the next delivery starts a fresh record. */
  end(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }
}
