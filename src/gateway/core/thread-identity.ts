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
import type { RemoteClaim } from "../../remote/fingerprint";

export interface ThreadIdentity {
  /** The person the turn runs as; undefined = the agent. */
  runAsUser: string | undefined;
  /** The /1on1 lock: null = unlocked; openScope null = locked, a string = open mode. */
  lock: { user: string; openScope: string | null } | null;
  /** The remote environment: a user-machine one only when it belongs to the
   *  runAs user; a provisioned sandbox whoever the turn runs as. */
  remote: RemoteClaim | undefined;
}

export async function threadIdentity(
  channel: string,
  thread: string,
  runAsFor: (lock: OneOnOne.OneOnOneLockRow | null) => Promise<string | undefined> | string | undefined,
): Promise<ThreadIdentity> {
  const lockRow = await OneOnOne.find(channel, thread);
  const runAsUser = await runAsFor(lockRow);
  // Remote mode (spec §4.5): a user-machine environment is signed in only for
  // its owner; a provisioned sandbox carries no personal secrets (spec §4).
  const target = env.remote.enabled() ? await activeRemoteTarget(channel, thread) : null;
  const applies = !!target && (target.env?.trust === "provisioned" || target.userId === runAsUser);
  return {
    runAsUser,
    lock: lockRow ? { user: lockRow.locked_user, openScope: lockRow.open_scope } : null,
    remote: applies ? { addr: target!.addr, dir: target!.dir, ...(target!.env ? { env: target!.env } : {}) } : undefined,
  };
}
