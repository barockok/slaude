/**
 * Where a completed /mcp connect lands on the gateway: the credential store,
 * not a config directory on the shared volume.
 *
 * The scope decides the owner exactly as the existing gates already decide who
 * may connect:
 *   global    → the agent's shared identity for this tenant and persona. Only a
 *               manager can run it, but the credential is the agent's, never the
 *               manager's own.
 *   initiator → the 1:1 lock owner, resolved to their account through their
 *               binding in this workspace. No binding means nowhere to keep it,
 *               and the caller tells them to /link first.
 *
 * The full grant is stored — refresh token and client secret included — because
 * the gateway is the only party that refreshes. It is encrypted at rest, and
 * nodes are only ever handed the access token (see the credential endpoint).
 */
import { accountForSlackUser } from "../../db/accounts";
import { deleteCredential, putCredential } from "../../db/mcp-credentials";
import type { CredentialOwner } from "../credential-owner";
import type { ConnectScope } from "./scope-home";
import { oauthKey, toStoredEntry, type OAuthServerConfig, type OAuthTokens } from "./store";

interface Target {
  scope: ConnectScope;
  tenant: string;
  /** Persona name; "default" for the unnamed persona. */
  persona: string;
  teamId: string;
  slackUserId: string;
  serverName: string;
  cfg: OAuthServerConfig;
}

async function ownerFor(t: Target): Promise<CredentialOwner | null> {
  if (t.scope === "global") return { kind: "agent", tenant: t.tenant, persona: t.persona || "default" };
  const account = await accountForSlackUser(t.teamId, t.slackUserId);
  return account ? { kind: "account", accountId: account.id } : null;
}

export async function persistConnect(
  t: Target & { tokens: OAuthTokens },
): Promise<{ ok: true } | { ok: false; reason: "no-account" }> {
  const owner = await ownerFor(t);
  if (!owner) return { ok: false, reason: "no-account" };
  // Unconditional: an explicit connect is the owner's own fresh grant and
  // always replaces what was there.
  await putCredential(owner, oauthKey(t.serverName, t.cfg), toStoredEntry(t.serverName, t.cfg, t.tokens));
  return { ok: true };
}

export async function persistDisconnect(
  t: Target,
): Promise<{ ok: true; removed: boolean } | { ok: false; reason: "no-account" }> {
  const owner = await ownerFor(t);
  if (!owner) return { ok: false, reason: "no-account" };
  return { ok: true, removed: await deleteCredential(owner, oauthKey(t.serverName, t.cfg)) };
}
