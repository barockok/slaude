import { createHash } from "node:crypto";

export interface SessionConfig {
  /** Whose identity the turn runs as (the lock owner, a cron's carried identity), or null for the agent. */
  runAs: string | null;
  /** The thread's /1on1 lock, as signed in the job token's `lock` claim: null =
   *  unlocked; openScope null = locked, a string = open with that scope. */
  lock: { user: string; openScope: string | null } | null;
  /** Where tools run, when the thread is remote. */
  remote: { addr: string; dir: string } | null;
}

/** Identifies the session config a turn expects: who it runs as, the whole
 *  /1on1 lock (the session-mode instructions depend on locked vs open and the
 *  scope), and where tools run. Signed into every job token; a node reboots a
 *  warm session when it changes (spec §4.4). */
export function sessionConfigFp(c: SessionConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.runAs,
        c.lock ? [c.lock.user, c.lock.openScope] : null,
        c.remote ? [c.remote.addr, c.remote.dir] : null,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
