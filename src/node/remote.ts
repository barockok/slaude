/**
 * Node-side remote mode (spec §4.5): the target rides in the signed claims of
 * the session's current job token. The key is fetched per handle from the
 * gateway, which re-verifies the token; it is held in memory only.
 */
import { parseRunAs } from "../agent/credential-owner";
import type { JobClaims } from "../gateway/api/auth";
import { HelperClient } from "../remote/helper-client";
import { cleanupCommand } from "../remote/tools/bash";
import { RemoteError, type RemoteHandle, type RemoteTarget } from "../remote/types";
import { NodeApiError, type NodeClient } from "./client";

/** How often an open handle to a SHARED machine asks the gateway again whether this turn may still use it. */
export const SHARED_REVALIDATE_MS = 2 * 60_000;

/** Unverified payload decode of a job token. Safe only because every sensitive
 *  use re-checks the signature at the gateway: the key endpoint verifies the
 *  token before serving anything, so a forged `remote` claim here gets nothing. */
export function decodeClaims(token: string): Partial<JobClaims> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

type TokenSource = { tokenFor(sessionId: string): string | undefined };

/** A session runs remotely when its token carries a target that applies: a
 *  user-machine environment (or a pre-environment tailcat claim) only for a
 *  turn that runs as a user; a provisioned sandbox for any turn. */
export function makeRemoteResolver(store: TokenSource): (sessionId: string) => Promise<RemoteTarget | null> {
  return async (sessionId) => {
    const token = store.tokenFor(sessionId);
    const c = token ? decodeClaims(token) : null;
    const r = c?.remote;
    if (!r) return null;
    const runAs = parseRunAs(c?.runAs);
    if (r.env?.trust === "provisioned") {
      return { teamId: c?.team ?? "", userId: runAs?.kind === "user" ? runAs.slackUserId : "", addr: "", dir: r.dir, env: r.env };
    }
    if (runAs?.kind !== "user") return null;
    return { teamId: c?.team ?? "", userId: runAs.slackUserId, addr: r.addr ?? "", dir: r.dir, ...(r.env ? { env: r.env } : {}) };
  };
}

type HelperOpts = ConstructorParameters<typeof HelperClient>[0];

export function makeRemoteFactory(o: {
  client: Pick<NodeClient, "getRemoteKey" | "getRemoteEnv">;
  store: TokenSource;
  tenants: { get(sessionId: string): string | undefined };
  newHelper?: (opts: HelperOpts) => RemoteHandle;
  /** Test seams for the shared-machine re-check. */
  revalidateMs?: number;
  now?: () => number;
}): (sessionId: string, target: RemoteTarget) => Promise<RemoteHandle> {
  const newHelper = o.newHelper ?? ((opts: HelperOpts) => new HelperClient(opts));
  return async (sessionId, target) => {
    const tenant = o.tenants.get(sessionId);
    const token = o.store.tokenFor(sessionId);
    if (!tenant || !token) throw new Error("no job token for remote session");
    // An environment claim: the gateway says how to reach it. A claim from a
    // gateway that predates environments: tailcat with the owner's key.
    const info = target.env
      ? await o.client.getRemoteEnv(tenant, token)
      : { transport: { kind: "tailcat" as const, addr: target.addr }, privateKey: await o.client.getRemoteKey(tenant, token) };
    const handle = newHelper({
      transport: info.transport,
      privateKey: info.privateKey,
      onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
    });
    if (!target.env?.shared) return handle;
    // A shared machine: the handle outlives the dispatch that opened it (a warm session, background jobs), so
    // the gateway is asked again from time to time. It re-runs the per-agent decision on the session's CURRENT
    // token; once the agent no longer allows the machine (or the definition is retired) the next exec is
    // refused and the session's remote jobs are cleaned up.
    const now = o.now ?? Date.now;
    const every = o.revalidateMs ?? SHARED_REVALIDATE_MS;
    let checkedAt = now();
    const stillAllowed = async () => {
      if (now() - checkedAt < every) return;
      const current = o.store.tokenFor(sessionId);
      try {
        if (!current) throw new Error("no job token");
        await o.client.getRemoteEnv(tenant, current);
        checkedAt = now();
      } catch (e) {
        // A definite no (the agent dropped it, the row is retired or changed): stop and clean up. A network blip only refuses this exec.
        if (e instanceof NodeApiError && (e.status === 403 || e.status === 409)) await handle.dispose().catch(() => {});
        throw new RemoteError("REMOTE_UNREACHABLE", "this agent may no longer use the shared environment");
      }
    };
    return { exec: async (cmd, opts) => { await stillAllowed(); return handle.exec(cmd, opts); }, release: () => handle.release(), dispose: () => handle.dispose() };
  };
}
