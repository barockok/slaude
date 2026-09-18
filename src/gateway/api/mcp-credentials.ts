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
import { json, readJson } from "./http";
import { parseRunAs, type CredentialOwner } from "../../agent/credential-owner";
import { accountForSlackUser } from "../../db/accounts";
import { credentialsFor } from "../../db/mcp-credentials";
import type { makeCredentialRefresher } from "../core/credential-refresh";
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

/** An entry this close to expiry is refreshed before it is handed to a node. */
const HAND_OUT_SKEW_MS = 60_000;

export async function handleMcpCredentials(
  _req: Request,
  claims: JobClaims,
  refresher?: CredentialRefresher,
): Promise<Response> {
  const resolved = await resolveOwner(claims);
  if (!resolved.ok) return resolved.response;
  const { owner } = resolved;
  // No account and no credentials look the same from outside: telling them
  // apart would reveal whether a person has an account.
  if (!owner) return json(200, { entries: {} });

  const entries = await credentialsFor(owner);
  // A node fetches at turn start. Handing out a token that is already expired
  // would make the turn's first MCP call fail, so refresh those first. The
  // refresher's own freshness check makes a concurrent refresh a no-op, and a
  // failure here just serves what is stored: the node's failure path remains.
  if (refresher) {
    const now = Date.now();
    await Promise.all(
      Object.entries(entries)
        .filter(([, e]) => e.refreshToken && e.expiresAt - now <= HAND_OUT_SKEW_MS)
        .map(async ([key]) => {
          try {
            const out = await refresher.refresh(owner, key, undefined);
            if (out.ok) entries[key] = out.entry;
          } catch {
            /* serve the stored entry */
          }
        }),
    );
  }

  const out: Record<string, NodeCredential> = {};
  for (const [key, e] of Object.entries(entries)) out[key] = toNodeCredential(e);
  return json(200, { entries: out });
}

export type CredentialRefresher = ReturnType<typeof makeCredentialRefresher>;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_KEY_LEN = 512;

/**
 * POST /v1/tenants/:tenant/mcp-credentials/refresh — refresh one server's
 * credential for the token's own runAs owner. The body names the server key and,
 * optionally, a SHA-256 of the access token that failed; never a token. The
 * response is the same access-token projection GET returns.
 *
 * 404 for a server the owner never connected AND for a person with no account,
 * so the two are indistinguishable. 409 means the grant is unusable and the
 * owner must reconnect. 503 is transient; the node may try again later.
 */
export async function handleMcpCredentialRefresh(
  req: Request,
  claims: JobClaims,
  refresher: CredentialRefresher,
): Promise<Response> {
  const resolved = await resolveOwner(claims);
  if (!resolved.ok) return resolved.response;

  const body = (await readJson(req)) as { serverKey?: unknown; failedAccessTokenHash?: unknown } | null;
  const serverKey = body?.serverKey;
  const failed = body?.failedAccessTokenHash;
  if (typeof serverKey !== "string" || serverKey.length === 0 || serverKey.length > MAX_KEY_LEN) {
    return json(400, { error: "serverKey must be a non-empty string" });
  }
  if (failed !== undefined && (typeof failed !== "string" || !SHA256_HEX.test(failed))) {
    return json(400, { error: "failedAccessTokenHash must be a lowercase hex SHA-256" });
  }

  if (!resolved.owner) return json(404, { error: "no such credential" });
  try {
    const out = await refresher.refresh(resolved.owner, serverKey, failed as string | undefined);
    if (out.ok) return json(200, { entry: toNodeCredential(out.entry) });
    if (out.reason === "reconnect") return json(409, { reconnect: true });
    return json(404, { error: "no such credential" });
  } catch (e) {
    // Transient: the provider or the lock. Named by class only.
    console.warn(`[mcp-credentials] refresh failed owner=${resolved.owner.kind} server=${serverKey} error=${e instanceof Error ? e.name : typeof e}`);
    return json(503, { error: "refresh unavailable, try again" });
  }
}
