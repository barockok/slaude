import { createHash } from "node:crypto";

/** Identifies the session config a turn expects: who the thread is locked to and
 *  where tools run. Signed into the job token; a node reboots a warm session
 *  when it changes (spec §4.4). */
export function sessionConfigFp(lockUser: string | null, remote: { addr: string; dir: string } | null): string {
  return createHash("sha256")
    .update(JSON.stringify([lockUser, remote ? [remote.addr, remote.dir] : null]))
    .digest("hex")
    .slice(0, 16);
}
