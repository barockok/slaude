/**
 * What this deployment offers a person, and what they already hold.
 *
 * The offer is the union of what the agents actually mount: every persona's
 * effective MCP servers, resolved the same way a session resolves them
 * (`sessionExternalMcp`), so the portal cannot offer a server no persona uses or
 * hide one a persona does. A server several personas share is one row, and a
 * single connect covers all of them, because the stored credential is keyed by
 * server name plus config, never by persona.
 *
 * Nothing here returns a token, an access token included. The page needs to know
 * whether a credential exists and roughly how long it lasts; it never needs the
 * credential, and an endpoint that could return one is an endpoint that
 * eventually does. Nor does it return a server's headers: they can carry a
 * persona's static credential.
 */
import { connectableServers, loadExternalMcp, type ExternalMcp } from "../core/external-mcp";
import { credentialExpiries } from "../../db/mcp-credentials";
import { oauthKey, type OAuthServerConfig } from "../../agent/mcp-oauth/store";
import { getPersonaRegistry, type PersonaRegistry } from "../../persona/registry";

/** Server name → config, as one persona mounts them. */
export type ConfiguredServers = Record<string, OAuthServerConfig>;

/** One connectable server, however many personas mount it. */
export interface PortalServer {
  /** What the page and the API call it. The server's name when that is unambiguous,
   *  otherwise the credential key (name plus a hash of its config), so two
   *  different servers that happen to share a name are never confused. */
  id: string;
  /** The name the agents know it by: what the stored credential is keyed on. */
  name: string;
  cfg: OAuthServerConfig;
  /** The personas that mount it, sorted. */
  usedBy: string[];
}

export interface IntegrationView {
  id: string;
  name: string;
  /** Host only. Enough to recognise the service, without a query or userinfo. */
  host: string;
  connected: boolean;
  /** Epoch ms, or null when not connected. Never a token. */
  expiresAt: number | null;
  usedBy: string[];
}

/** Merge each persona's servers into one list. Two entries are the same server
 *  when their credential key matches (name, URL and headers), which is exactly
 *  when one stored credential serves both. */
export function aggregateServers(sources: Array<{ persona: string; servers: ConfiguredServers }>): PortalServer[] {
  const byKey = new Map<string, { name: string; cfg: OAuthServerConfig; personas: Set<string> }>();
  for (const { persona, servers } of sources) {
    for (const [name, cfg] of Object.entries(servers)) {
      const key = oauthKey(name, cfg);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { name, cfg, personas: new Set() };
        byKey.set(key, entry);
      }
      entry.personas.add(persona);
    }
  }

  const perName = new Map<string, number>();
  for (const { name } of byKey.values()) perName.set(name, (perName.get(name) ?? 0) + 1);

  const taken = new Set<string>();
  const rows: PortalServer[] = [];
  for (const [key, e] of byKey) {
    // A bare name only when nothing else shares it; the key otherwise.
    const id = perName.get(e.name) === 1 && !taken.has(e.name) ? e.name : key;
    taken.add(id);
    rows.push({ id, name: e.name, cfg: e.cfg, usedBy: [...e.personas].sort() });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The deployment's connectable servers: what every persona mounts. Read per
 *  request, so an operator's edit to a persona's MCP shows up without a restart. */
export function portalServers(opts: { registry?: PersonaRegistry; global?: ExternalMcp } = {}): PortalServer[] {
  const registry = opts.registry ?? getPersonaRegistry();
  const global = opts.global ?? loadExternalMcp();
  const personas = [...new Set(["default", ...registry.list().map((p) => p.name)])];
  return aggregateServers(
    personas.map((persona) => ({
      persona,
      servers: connectableServers(persona === "default" ? undefined : persona, global, registry),
    })),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One row per connectable server, marking the ones this account holds. */
export async function integrationsFor(accountId: string, servers: PortalServer[] = portalServers()): Promise<IntegrationView[]> {
  const held = await credentialExpiries({ kind: "account", accountId });
  return servers.map((s) => {
    const expiresAt = held[oauthKey(s.name, s.cfg)] ?? null;
    return {
      id: s.id,
      name: s.name,
      host: hostOf(s.cfg.url),
      connected: expiresAt !== null,
      expiresAt,
      usedBy: s.usedBy,
    };
  });
}

/** The configured server with that id, or null. A connect must never act on a
 *  server this deployment does not configure: the id arrives from the request,
 *  and the URL it would otherwise imply is where an access token gets sent. */
export function configuredServer(id: string, servers: PortalServer[] = portalServers()): PortalServer | null {
  return servers.find((s) => s.id === id) ?? null;
}
