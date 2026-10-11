import * as OneOnOne from "../db/one-on-one";
import * as Remote from "../db/remote";
import type { RemoteTarget } from "./types";

/** The thread's remote target, only while the invariant holds: a LOCKED 1on1
 *  owned by the target's user. Anything else means "run locally". */
export async function activeRemoteTarget(channelId: string, threadTs: string): Promise<RemoteTarget | null> {
  const [t, lock] = await Promise.all([Remote.findTarget(channelId, threadTs), OneOnOne.find(channelId, threadTs)]);
  if (!t || !lock || lock.open_scope !== null || lock.locked_user !== t.user_id) return null;
  return { teamId: t.team_id, userId: t.user_id, addr: t.addr, dir: t.dir };
}
