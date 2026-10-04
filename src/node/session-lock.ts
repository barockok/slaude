/**
 * Node-side /1on1 lock: read from the signed `lock` claim of the session's
 * current job token, never from a database (a node has none). The decode is
 * unverified, like the remote claim: the lock only shapes the system prompt,
 * and the token came from the gateway through the queue.
 */
import type { OneOnOneLockRow } from "../db/one-on-one";
import { decodeClaims } from "./remote";

type TokenSource = { tokenFor(sessionId: string): string | undefined };

/** The lock as a row, null when unlocked, undefined when the token carries no
 *  lock claim (an older gateway) so the caller can fall back. */
export function lockFromClaims(store: TokenSource, sessionId: string): OneOnOneLockRow | null | undefined {
  const token = store.tokenFor(sessionId);
  const c = token ? decodeClaims(token) : null;
  if (!c || !("lock" in c)) return undefined;
  if (!c.lock) return null;
  return {
    channel_id: c.channel ?? "",
    thread_ts: c.thread ?? "",
    locked_user: c.lock.user,
    created_by: "",
    created_at: 0,
    open_scope: c.lock.openScope ?? null,
  };
}
