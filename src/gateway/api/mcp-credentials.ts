/**
 * GET /v1/tenants/:tenant/mcp-credentials — the credentials a turn runs with.
 *
 * The owner is resolved ONLY from the job token's signed `runAs` claim, never
 * from the path. There is no owner parameter a caller could change to reach
 * someone else's credentials. The router has already checked the static
 * bearer, verified the job token, and matched its tenant to the path.
 *
 * A node receives a PROJECTION: the access token and what the agent needs to
 * call the server with it. The refresh token and client secret never leave the
 * gateway. The agent cannot rotate what it does not hold, so the gateway is the
 * only refresher by construction rather than by agreement, and a compromised
 * node leaks only short-lived access tokens. It also leaves a node nothing to
 * write back, so there is no write path here for a compromised node to plant a
 * credential through.
 */
import type { JobClaims } from "./auth";
import { json } from "./http";
import { parseRunAs, type CredentialOwner } from "../../agent/credential-owner";
import { accountForSlackUser } from "../../db/accounts";
import { credentialsFor } from "../../db/mcp-credentials";
import type { StoredEntry } from "../../agent/mcp-oauth/store";

type Resolved = { ok: true; owner: CredentialOwner | null } | { ok: false; response: Response };

/** The token's owner. `owner: null` means a person with no bound account. */
async function resolveOwner(claims: JobClaims): Promise<Resolved> {
  const runAs = parseRunAs(claims.runAs);
  if (!runAs) {
    // Absent or malformed. Never defaulted to the agent: a token from before
    // runAs existed must not read the agent's shared credentials by accident.
    return { ok: false, response: json(403, { error: "job token does not say whose identity this turn runs as" }) };
  }
  if (runAs.kind === "agent") {
    return { ok: true, owner: { kind: "agent", tenant: claims.tenant, persona: claims.persona } };
  }
  // A person is resolved through their binding in the token's own workspace.
  const account = await accountForSlackUser(claims.team, runAs.slackUserId);
  return { ok: true, owner: account ? { kind: "account", accountId: account.id } : null };
}

/** What a node may hold for one server. Everything else stays on the gateway. */
export type NodeCredential = Pick<StoredEntry, "serverName" | "serverUrl" | "accessToken" | "expiresAt"> & {
  clientId?: string;
};

/** The node-facing projection. An allowlist, not a denylist: a field added to
 *  StoredEntry later does not reach nodes until someone decides it should. */
export function toNodeCredential(e: StoredEntry): NodeCredential {
  return {
    serverName: e.serverName,
    serverUrl: e.serverUrl,
    accessToken: e.accessToken,
    expiresAt: e.expiresAt,
    ...(e.clientId ? { clientId: e.clientId } : {}),
  };
}

export async function handleMcpCredentials(_req: Request, claims: JobClaims): Promise<Response> {
  const resolved = await resolveOwner(claims);
  if (!resolved.ok) return resolved.response;
  const { owner } = resolved;
  // No account and no credentials look the same from outside: telling them
  // apart would reveal whether a person has an account.
  if (!owner) return json(200, { entries: {} });
  const out: Record<string, NodeCredential> = {};
  for (const [key, e] of Object.entries(await credentialsFor(owner))) out[key] = toNodeCredential(e);
  return json(200, { entries: out });
}
