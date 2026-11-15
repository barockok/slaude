/**
 * Who a thread's turn runs as, computed from the database now: the /1on1 lock,
 * the effective runAs user, and the remote target signed for that user. One
 * computation for the job token at dispatch and for the fresh identity the
 * token-refresh route reports (voice mode: a call re-checks it before every
 * injected turn). Every lookup failure throws: callers must not default to
 * the agent.
 */
import * as OneOnOne from "../../db/one-on-one";
import { remoteDecision, sharedBindingPresent, REFUSED_REMOTE_OFF_NOTICE, type Refusal, type TurnKind } from "../../remote/definitions/decision";
import { sameAt } from "../../access/wired";
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
  /** The thread is bound to a shared environment this turn may not use. The turn must not run, and must not run on the server either. */
  refused?: Refusal;
}

/** Who is asking, for the shared-environment rule. Absent means the safest answer: no persona, not interactive. */
export interface IdentityAsker {
  tenant: string;
  persona: string | undefined;
  turnKind: TurnKind;
}
const FAIL_CLOSED_ASKER: IdentityAsker = { tenant: "default", persona: undefined, turnKind: "other" };

export async function threadIdentity(
  channel: string,
  thread: string,
  runAsFor: (lock: OneOnOne.OneOnOneLockRow | null) => Promise<string | undefined> | string | undefined,
  asker: IdentityAsker = FAIL_CLOSED_ASKER,
): Promise<ThreadIdentity> {
  const lockRow = await OneOnOne.find(channel, thread);
  const runAsUser = await runAsFor(lockRow);
  // Remote mode (spec §4.5): a user-machine environment is signed in only for
  // its owner; a provisioned sandbox carries no personal secrets (spec §4).
  let refused: Refusal | undefined;
  let target = null;
  if (env.remote.enabled()) {
    const d = await remoteDecision({ tenant: asker.tenant, persona: asker.persona, channel, thread, turnKind: asker.turnKind });
    if ("refused" in d) refused = d.refused;
    else if ("target" in d) target = d.target;
  } else if (await sharedBindingPresent(channel, thread)) {
    // Remote mode is off but the thread is still bound to a shared machine: never fall through to the server.
    refused = { code: "SHARED_ENV_REMOTE_OFF", message: REFUSED_REMOTE_OFF_NOTICE };
  }
  const applies = !refused && !!target && (target.env?.trust === "provisioned" || (await sameAt({ site: "remote.thread_identity_run_as", persona: null, teamId: target.teamId, userId: target.userId, otherUserId: runAsUser })));
  return {
    runAsUser,
    lock: lockRow ? { user: lockRow.locked_user, openScope: lockRow.open_scope } : null,
    remote: applies ? { addr: target!.addr, dir: target!.dir, ...(target!.env ? { env: target!.env } : {}) } : undefined,
    ...(refused ? { refused } : {}),
  };
}
