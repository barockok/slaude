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
import { bumpMcpCredEpoch } from "../../gateway/core/mcp-cred-epoch";

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

/**
 * Store a completed grant for an owner the caller has already resolved.
 *
 * The portal knows whose account it is acting for from the signed-in session,
 * so it has nothing to resolve from a Slack scope. Both surfaces write through
 * here, so a credential connected in the portal is the same row a 1:1 connect
 * would have written.
 *
 * Unconditional: an explicit connect is the owner's own fresh grant and always
 * replaces what was there.
 */
export async function persistConnectForOwner(
  owner: CredentialOwner,
  serverName: string,
  cfg: OAuthServerConfig,
  tokens: OAuthTokens,
): Promise<void> {
  await putCredential(owner, oauthKey(serverName, cfg), toStoredEntry(serverName, cfg, tokens));
  // Warm sessions of this identity reboot on their next turn and re-list
  // their bridged tools (mcp-cred-epoch.ts).
  await bumpMcpCredEpoch(owner);
}

export async function persistConnect(
  t: Target & { tokens: OAuthTokens },
): Promise<{ ok: true } | { ok: false; reason: "no-account" }> {
  const owner = await ownerFor(t);
  if (!owner) return { ok: false, reason: "no-account" };
  await persistConnectForOwner(owner, t.serverName, t.cfg, t.tokens);
  return { ok: true };
}

export async function persistDisconnect(
  t: Target,
): Promise<{ ok: true; removed: boolean } | { ok: false; reason: "no-account" }> {
  const owner = await ownerFor(t);
  if (!owner) return { ok: false, reason: "no-account" };
  const removed = await deleteCredential(owner, oauthKey(t.serverName, t.cfg));
  if (removed) await bumpMcpCredEpoch(owner);
  return { ok: true, removed };
}
