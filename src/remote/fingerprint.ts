import { createHash } from "node:crypto";
import type { EnvRef } from "./types";

/** The `remote` job-token claim (spec §6): the environment by reference. `addr`
 *  is the tailcat address for a tailcat environment, so a node that predates
 *  environments still works during a rollout; "" for every other kind, which
 *  such a node refuses (fail closed). */
export interface RemoteClaim {
  addr: string;
  dir: string;
  env?: EnvRef;
}

/** A tailcat environment keeps the pre-environment fingerprint part, so
 *  migrated threads do not reboot; every other kind is named by reference. */
function remotePart(r: RemoteClaim | null): unknown {
  if (!r) return null;
  if (r.env && r.env.kind !== "tailcat") return ["env", r.env.kind, r.env.id, r.env.hash, r.dir];
  return [r.addr, r.dir];
}

export interface SessionConfig {
  /** Whose identity the turn runs as (the lock owner, a cron's carried identity), or null for the agent. */
  runAs: string | null;
  /** The thread's /1on1 lock, as signed in the job token's `lock` claim: null =
   *  unlocked; openScope null = locked, a string = open with that scope. */
  lock: { user: string; openScope: string | null } | null;
  /** Where tools run, when the thread is remote. */
  remote: RemoteClaim | null;
  /** MCP credential epochs of the turn's identities (mcp-cred-epoch.ts): a
   *  connect or disconnect changes it, so a warm session reboots and re-lists
   *  its bridged tools. Empty or absent leaves the fingerprint as before. */
  mcpEpoch?: string;
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
        remotePart(c.remote),
        // Appended only when set, so every existing fingerprint is unchanged.
        ...(c.mcpEpoch ? [c.mcpEpoch] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
