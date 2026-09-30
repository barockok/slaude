/**
 * What this deployment offers a person, and what they already hold.
 *
 * The server list comes from the same configured HTTP MCP servers `/mcp` uses in
 * Slack, so the portal and the Slack command cannot disagree about what is
 * connectable.
 *
 * Nothing here returns a token, an access token included. The page needs to know
 * whether a credential exists and roughly how long it lasts; it never needs the
 * credential, and an endpoint that could return one is an endpoint that
 * eventually does.
 */
import { loadExternalMcp, oauthHttpServers } from "../core/external-mcp";
import { credentialExpiries } from "../../db/mcp-credentials";
import { oauthKey, type OAuthServerConfig } from "../../agent/mcp-oauth/store";

export type ConfiguredServers = Record<string, OAuthServerConfig>;

export interface IntegrationView {
  name: string;
  /** Host only. Enough to recognise the service, without a query or userinfo. */
  host: string;
  connected: boolean;
  /** Epoch ms, or null when not connected. Never a token. */
  expiresAt: number | null;
}

/** The deployment's connectable servers. Read per request, so an operator's
 *  edit to .mcp.json shows up without a restart. */
export function configuredServers(): ConfiguredServers {
  return oauthHttpServers(loadExternalMcp().servers);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One row per configured server, marking the ones this account holds. */
export async function integrationsFor(
  accountId: string,
  servers: ConfiguredServers = configuredServers(),
): Promise<IntegrationView[]> {
  const held = await credentialExpiries({ kind: "account", accountId });
  return Object.entries(servers)
    .map(([name, cfg]) => {
      const expiresAt = held[oauthKey(name, cfg)] ?? null;
      return { name, host: hostOf(cfg.url), connected: expiresAt !== null, expiresAt };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The configured server by that name, or null. A connect must never act on a
 *  server this deployment does not configure: the name arrives from the request,
 *  and the URL it would otherwise imply is where an access token gets sent. */
export function configuredServer(name: string, servers: ConfiguredServers = configuredServers()): OAuthServerConfig | null {
  return Object.prototype.hasOwnProperty.call(servers, name) ? servers[name]! : null;
}
