/**
 * Who a thread's turn runs as, computed from the database now: the /1on1 lock,
 * the effective runAs user, and the remote target signed for that user. One
 * computation for the job token at dispatch and for the fresh identity the
 * token-refresh route reports (voice mode: a call re-checks it before every
 * injected turn). Every lookup failure throws: callers must not default to
 * the agent.
 */
import * as OneOnOne from "../../db/one-on-one";
import { activeRemoteTarget } from "../../remote/active";
import { env } from "../../config/env";

export interface ThreadIdentity {
  /** The person the turn runs as; undefined = the agent. */
  runAsUser: string | undefined;
  /** The /1on1 lock: null = unlocked; openScope null = locked, a string = open mode. */
  lock: { user: string; openScope: string | null } | null;
  /** The remote target, only when it belongs to the runAs user. */
  remote: { addr: string; dir: string } | undefined;
}

export async function threadIdentity(
  channel: string,
  thread: string,
  runAsFor: (lock: OneOnOne.OneOnOneLockRow | null) => Promise<string | undefined> | string | undefined,
): Promise<ThreadIdentity> {
  const lockRow = await OneOnOne.find(channel, thread);
  const runAsUser = await runAsFor(lockRow);
  // Remote mode (spec §4.5): only a target owned by the runAs user is signed in.
  const target = env.remote.enabled() ? await activeRemoteTarget(channel, thread) : null;
  return {
    runAsUser,
    lock: lockRow ? { user: lockRow.locked_user, openScope: lockRow.open_scope } : null,
    remote: target && target.userId === runAsUser ? { addr: target.addr, dir: target.dir } : undefined,
  };
}
