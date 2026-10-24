/**
 * Node-side remote mode (spec §4.5): the target rides in the signed claims of
 * the session's current job token. The key is fetched per handle from the
 * gateway, which re-verifies the token; it is held in memory only.
 */
import { parseRunAs } from "../agent/credential-owner";
import type { JobClaims } from "../gateway/api/auth";
import { HelperClient } from "../remote/helper-client";
import { cleanupCommand } from "../remote/tools/bash";
import type { RemoteHandle, RemoteTarget } from "../remote/types";
import type { NodeClient } from "./client";

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
    return newHelper({
      transport: info.transport,
      privateKey: info.privateKey,
      onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
    });
  };
}
