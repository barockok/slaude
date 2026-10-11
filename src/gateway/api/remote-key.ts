import type { JobClaims } from "./auth";
import { json } from "./http";
import { parseRunAs } from "../../agent/credential-owner";
import * as Remote from "../../db/remote";

/** The runAs user's SSH private key, for a turn whose signed claims put it in
 *  remote mode. Nothing else can obtain it (spec §4.5). */
export async function handleRemoteKey(_req: Request, claims: JobClaims): Promise<Response> {
  const runAs = parseRunAs(claims.runAs);
  if (!runAs || runAs.kind !== "user") return json(403, { error: "remote keys are only served to user-scoped turns" });
  if (!claims.remote) return json(403, { error: "this turn is not in remote mode" });
  const key = await Remote.getKey(claims.team, runAs.slackUserId);
  if (!key) return json(404, { error: "no remote key" });
  return json(200, { privateKey: key.privateKey });
}
