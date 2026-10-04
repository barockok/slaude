/**
 * The panel's read model of one persona (WS-C §4.4.1): what an administrator
 * needs to answer "what is this agent, and where does it run", built only from
 * presence and references, never from values.
 *
 * What never leaves this module: an MCP server's URL, query string, userinfo,
 * headers, env, command or arguments; a provider credential's value (only a
 * reference's path, or "stored" for anything that is not a valid reference);
 * the persona's Slack user token. Each builder whitelists the fields it emits,
 * so a field added to a persona's config later is absent until someone adds it
 * here on purpose.
 */
import { parseRef, canonicalRef } from "../../secrets/ref";
import { PROVIDER_SECRET_FIELDS, type PersonaProvider } from "../../persona/sync/payload";
import { DEFAULT_LABEL } from "../../queue/keys";
import type { Registry } from "../../queue/registry";

/** How a node reaches the server: through the gateway's MCP bridge (http), as a
 *  node-local stdio server, or not at all in the gateway role (e.g. sse). */
export type McpVia = "bridge" | "stdio" | "none";
export type McpType = "http" | "sse" | "stdio" | "other";

export interface McpServerView {
  name: string;
  via: McpVia;
  type: McpType;
  /** Hostname only (no scheme, port, path, query or userinfo); null for stdio. */
  host: string | null;
  /** The persona's agent identity holds an OAuth credential for this server. */
  oauth: boolean;
}

export type BridgedConfig = { type: "http"; url: string; headers?: Record<string, string> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function hostnameOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function typeOf(cfg: Record<string, unknown>): McpType {
  const t = cfg.type;
  if (t === "http" || t === "sse" || t === "stdio") return t;
  if (t === undefined && typeof cfg.command === "string") return "stdio";
  return "other";
}

/**
 * One row per server in a `{ mcpServers: { … } }` value. `agentHolds` answers
 * whether the agent holds an OAuth credential for a bridged server's exact
 * config (the credential key hashes type, URL and headers); it is asked only
 * for servers the bridge would serve.
 */
export function mcpServersView(mcp: unknown, agentHolds: (name: string, cfg: BridgedConfig) => boolean): McpServerView[] {
  if (!isObj(mcp) || !isObj(mcp.mcpServers)) return [];
  return Object.entries(mcp.mcpServers)
    .map(([name, raw]): McpServerView => {
      const cfg = isObj(raw) ? raw : {};
      const type = typeOf(cfg);
      // Exactly the set oauthHttpServers (and so the bridge) serves.
      const bridged = cfg.type === "http" && typeof cfg.url === "string";
      return {
        name,
        via: bridged ? "bridge" : type === "stdio" ? "stdio" : "none",
        type,
        host: type === "stdio" || type === "other" ? null : hostnameOf(cfg.url),
        oauth: bridged
          ? agentHolds(name, { type: "http", url: cfg.url as string, headers: cfg.headers as Record<string, string> | undefined })
          : false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A credential field as the panel shows it: the reference itself, "stored"
 *  for a value that is not a valid reference (never echoed), or "none". */
export function secretRefView(v: string | undefined | null): string {
  if (!v) return "none";
  try {
    return canonicalRef(parseRef(v));
  } catch {
    return "stored";
  }
}

export interface ProviderView {
  apiKey: string;
  authToken: string;
  oauthToken: string;
  /** A reference, or an URL reduced to scheme, host and path; null when unset. */
  baseUrl: string | null;
}

function baseUrlView(v: string | undefined): string | null {
  if (!v) return null;
  if (v.startsWith("vault://") || v.startsWith("env://")) return secretRefView(v);
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "stored";
  }
}

export function providerView(p: PersonaProvider | null | undefined): ProviderView {
  const out = Object.fromEntries(PROVIDER_SECRET_FIELDS.map((f) => [f, secretRefView(p?.[f])])) as Omit<ProviderView, "baseUrl">;
  return { ...out, baseUrl: baseUrlView(p?.baseUrl) };
}

export type KbMode = "all" | "none" | "list";
export interface KbView {
  mode: KbMode;
  sources: Array<{ id: string; installed: boolean }>;
}

export const kbMode = (list: readonly string[] | null | undefined): KbMode =>
  list == null ? "all" : list.length === 0 ? "none" : "list";

/** null = every installed KB, [] = none, a list = those ids (installed or not). */
export function kbView(list: readonly string[] | null | undefined, installed: readonly string[]): KbView {
  const mode = kbMode(list);
  const have = new Set(installed);
  const ids = mode === "all" ? [...have] : [...(list ?? [])];
  return { mode, sources: ids.map((id) => ({ id, installed: have.has(id) })) };
}

export const SOUL_PREVIEW_CHARS = 200;
export function soulView(soulMd: string, overridden: boolean) {
  return { length: soulMd.length, overridden, preview: soulMd.slice(0, SOUL_PREVIEW_CHARS) };
}

export interface NodeView {
  id: string;
  alive: boolean;
  labels: string[];
}

/**
 * The live nodes holding the persona's label (`default` when it names none),
 * read from the registry's heartbeats. null when there is no node registry
 * (mono, or no Redis): "unknown", not "no nodes".
 */
export async function personaNodes(
  registry: Pick<Registry, "liveNodesHolding"> | null,
  runsOn: string | null | undefined,
): Promise<NodeView[] | null> {
  if (!registry) return null;
  // One read decides both membership and labels (no per-node second read).
  return (await registry.liveNodesHolding(runsOn ?? DEFAULT_LABEL)).map((n) => ({ id: n.node, alive: true, labels: n.labels }));
}
