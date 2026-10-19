import type { JobClaims } from "./auth";
import { json } from "./http";
import { parseRunAs } from "../../agent/credential-owner";
import { activeRemoteTarget, boundEnv } from "../../remote/active";
import { connectInfoForBinding } from "../../remote/env-runtime";
import { RemoteError } from "../../remote/types";

/**
 * How to reach the turn's environment (environments spec §6): the transport
 * and private key the node's helper connects with. Served only for a token
 * whose signed `remote` claim names the environment the thread is bound to
 * right now, with the same hash, and only while its trust class still applies
 * (a user-machine environment: to its owner's own turns under their lock).
 */
export async function handleRemoteEnv(_req: Request, claims: JobClaims): Promise<Response> {
  const ref = claims.remote?.env;
  if (!ref) return json(403, { error: "this turn is not in an environment" });
  const b = await boundEnv(claims.channel, claims.thread);
  if (!b || b.env.id !== ref.id || b.env.teamId !== claims.team) return json(409, { error: "the thread's environment changed" });
  const target = await activeRemoteTarget(claims.channel, claims.thread);
  if (!target?.env || target.env.id !== ref.id || target.env.hash !== ref.hash) return json(409, { error: "the thread's environment changed" });
  if (target.env.trust === "user-machine") {
    const runAs = parseRunAs(claims.runAs);
    if (!runAs || runAs.kind !== "user" || runAs.slackUserId !== b.env.userId) {
      return json(403, { error: "a personal environment is only served to its owner's turns" });
    }
  }
  try {
    const info = await connectInfoForBinding(b.binding, b.env);
    return json(200, { transport: info.transport, privateKey: info.privateKey });
  } catch (e) {
    if (e instanceof RemoteError) return json(409, { error: e.message, code: e.code });
    throw e;
  }
}
