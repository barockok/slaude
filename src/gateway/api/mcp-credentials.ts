/**
 * GET  /v1/tenants/:tenant/mcp-credentials — the credentials a turn runs with.
 * POST /v1/tenants/:tenant/mcp-credentials — write back what the agent changed.
 *
 * The owner is resolved ONLY from the job token's signed `runAs` claim, never
 * from the path or the body. There is no owner parameter a caller could change
 * to reach someone else's credentials. The router has already checked the
 * static bearer, verified the job token, and matched its tenant to the path.
 *
 * Responses never contain a credential the owner does not hold, and error
 * bodies never contain any credential at all: validation errors name the
 * server key and the failing field, not a value.
 */
import type { JobClaims } from "./auth";
import { json, readJson } from "./http";
import { parseRunAs, type CredentialOwner } from "../../agent/credential-owner";
import { accountForSlackUser } from "../../db/accounts";
import { credentialsFor, putCredentialIfNewer } from "../../db/mcp-credentials";
import type { StoredEntry } from "../../agent/mcp-oauth/store";

/** Server keys are `<name>|<16 hex>` in practice; bound them loosely but firmly. */
const MAX_KEY_LEN = 512;
const MAX_ENTRIES = 256;

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

/** Why an entry is unacceptable, naming a field but never echoing a value. */
function entryProblem(e: unknown): string | null {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "entry must be an object";
  const v = e as Record<string, unknown>;
  for (const k of ["serverName", "serverUrl", "accessToken"] as const) {
    if (typeof v[k] !== "string" || (v[k] as string).length === 0) return `${k} must be a non-empty string`;
  }
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return "expiresAt must be a finite number";
  for (const k of ["refreshToken", "clientId", "clientSecret"] as const) {
    if (v[k] !== undefined && typeof v[k] !== "string") return `${k} must be a string when present`;
  }
  return null;
}

export async function handleMcpCredentials(req: Request, claims: JobClaims): Promise<Response> {
  const resolved = await resolveOwner(claims);
  if (!resolved.ok) return resolved.response;
  const { owner } = resolved;

  if (req.method === "GET") {
    // No account and no credentials look the same from outside: telling them
    // apart would reveal whether a person has an account.
    return json(200, { entries: owner ? await credentialsFor(owner) : {} });
  }

  const body = await readJson(req);
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return json(400, { error: "body must be { entries: { <serverKey>: <entry> } }" });
  }
  const pairs = Object.entries(entries as Record<string, unknown>);
  if (pairs.length > MAX_ENTRIES) return json(400, { error: `at most ${MAX_ENTRIES} entries per request` });

  // Validate everything before writing anything, so a bad entry can never
  // leave a partial write behind.
  for (const [key, e] of pairs) {
    if (key.length === 0 || key.length > MAX_KEY_LEN) return json(400, { error: "invalid server key" });
    const problem = entryProblem(e);
    if (problem) return json(400, { error: `invalid entry for ${key}: ${problem}` });
  }

  if (!owner) {
    // A person with no bound account has nowhere to keep a credential.
    return json(409, { error: "no account is bound to this identity" });
  }

  let written = 0;
  for (const [key, e] of pairs) {
    if (await putCredentialIfNewer(owner, key, e as StoredEntry)) written++;
  }
  return json(200, { ok: true, written });
}
