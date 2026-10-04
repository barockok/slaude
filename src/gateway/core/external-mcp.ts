import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";
import { isGatewayOnlyEnv } from "../../config/gateway-only-env";
import { getPersonaRegistry, type PersonaRegistry } from "../../persona/registry";

/** Return a copy of a server config with all injected secrets removed.
 *  stdio → env emptied; sse/http → headers emptied + url userinfo/query/hash stripped.
 *  command/args and url host/path are preserved so the server still launches/reaches
 *  its endpoint — just anonymous. The input is never mutated.
 *  An `sdk`-type (in-process) config carries no env/headers/url, so it passes through
 *  unchanged — those servers come from code, never `.mcp.json`, so they can't be
 *  named in `privateServices` anyway. */
export function clearCredentials(cfg: McpServerConfig): McpServerConfig {
  const c: any = { ...(cfg as any) };
  if ("env" in c) c.env = {};
  if ("headers" in c) c.headers = {};
  if (typeof c.url === "string") {
    try {
      const u = new URL(c.url);
      u.username = "";
      u.password = "";
      u.search = "";
      u.hash = "";
      c.url = u.toString();
    } catch {
      // Non-absolute URL: leave as-is (can't carry userinfo/query meaningfully).
    }
  }
  return c as McpServerConfig;
}

export interface ExternalMcp {
  servers: Record<string, McpServerConfig>;
  privateServices: string[];
}

/** Parse a `.mcp.json`-shaped object: expand ${VAR} placeholders across stdio/http
 *  fields and read the `privateServices` whitelist. Names not present in `mcpServers`
 *  are warned-about and dropped. `env` is injectable for testing. Note: mutates the
 *  parsed input in place (placeholders are expanded on the server configs). */
export function parseExternalMcp(
  parsed: any,
  env: Record<string, string | undefined> = process.env,
): ExternalMcp {
  // .mcp.json sits on $SLAUDE_HOME, which agent turns can write. A placeholder
  // naming a gateway-only variable (master key, job secret, database URLs, Slack
  // secrets, PERSONA_*, ...) is left as written: expanding it would hand the
  // gateway's secret to whatever server config the file names. Name logged only.
  const expand = (s: string) =>
    s.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => {
      if (isGatewayOnlyEnv(name)) {
        console.warn(`[mcp] .mcp.json references gateway-only variable ${name}; left unexpanded`);
        return whole;
      }
      return env[name] ?? "";
    });
  const servers: Record<string, McpServerConfig> = parsed?.mcpServers ?? {};
  for (const cfg of Object.values<any>(servers)) {
    if (cfg?.env && typeof cfg.env === "object") {
      for (const [k, v] of Object.entries<any>(cfg.env)) if (typeof v === "string") cfg.env[k] = expand(v);
    }
    if (cfg?.headers && typeof cfg.headers === "object") {
      for (const [k, v] of Object.entries<any>(cfg.headers)) if (typeof v === "string") cfg.headers[k] = expand(v);
    }
    if (typeof cfg?.url === "string") cfg.url = expand(cfg.url);
    if (Array.isArray(cfg?.args)) cfg.args = cfg.args.map((a: unknown) => (typeof a === "string" ? expand(a) : a));
  }
  const raw: unknown = parsed?.privateServices;
  const list = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  const privateServices = list.filter((n) => {
    const ok = n in servers;
    if (!ok) console.warn(`[mcp] privateServices entry "${n}" is not a configured server — ignored`);
    return ok;
  });
  return { servers, privateServices };
}

/**
 * The servers that can hold an OAuth credential: HTTP ones with a URL.
 *
 * `/mcp` in Slack and the portal's integrations page both resolve their list
 * through here, so the two surfaces cannot disagree about what is connectable.
 */
export function oauthHttpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, { type: "http"; url: string; headers?: Record<string, string> }> {
  const out: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};
  for (const [name, cfg] of Object.entries<any>(servers)) {
    if (cfg?.type === "http" && typeof cfg.url === "string") {
      out[name] = { type: "http", url: cfg.url, headers: cfg.headers };
    }
  }
  return out;
}

/** The OAuth-connectable HTTP servers one persona mounts, resolved the way its
 *  sessions resolve them. Slack's `/mcp` and the portal both go through here
 *  (the portal unions it over personas), so a persona-only server is offered,
 *  and accepted on connect, identically on both. Declared before
 *  `sessionExternalMcp` in the file; a function declaration, so order is moot. */
export function connectableServers(
  personaId: string | null | undefined,
  globalMcp: ExternalMcp,
  registry?: PersonaRegistry,
): ReturnType<typeof oauthHttpServers> {
  return oauthHttpServers(sessionExternalMcp(personaId, globalMcp, registry).servers);
}

/** Per-session overrides: when the thread is /1on1-locked, return cleared copies of
 *  each whitelisted server so they mount anonymous. Empty when unlocked. Source map
 *  is never mutated (clearCredentials copies). */
export function privateOverrides(
  servers: Record<string, McpServerConfig>,
  privateServices: ReadonlySet<string>,
  isLocked: boolean,
): Record<string, McpServerConfig> {
  if (!isLocked) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const name of privateServices) {
    const cfg = servers[name];
    if (cfg) out[name] = clearCredentials(cfg);
  }
  return out;
}

/** Load + parse `~/.slaude/.mcp.json` (global) or `~/.slaude/personas/<name>/mcp.json`
 *  (per-persona). Missing file → empty result. */
export function loadExternalMcp(personaName?: string): ExternalMcp {
  const f = personaName
    ? join(paths.personas, personaName.toLowerCase(), "mcp.json")
    : join(paths.home, ".mcp.json");
  if (!existsSync(f)) return { servers: {}, privateServices: [] };
  try {
    return parseExternalMcp(JSON.parse(readFileSync(f, "utf8")));
  } catch (err) {
    console.error(`[mcp] failed to load ${f}:`, err);
    return { servers: {}, privateServices: [] };
  }
}

let globalCache: { stamp: string; value: ExternalMcp } | null = null;

/** The global `.mcp.json`, re-read only when the file changes. The MCP bridge
 *  and the runtime bundle resolve it per request through here, so both agree on
 *  what a persona mounts without a file read per tool call. Callers get a deep
 *  copy: the cached value is never handed out to be mutated. */
export function currentGlobalMcp(): ExternalMcp {
  const f = join(paths.home, ".mcp.json");
  let stamp: string;
  try {
    const st = statSync(f);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    globalCache = null;
    return { servers: {}, privateServices: [] };
  }
  if (!globalCache || globalCache.stamp !== stamp) globalCache = { stamp, value: loadExternalMcp() };
  return structuredClone(globalCache.value);
}

/** The persona's servers the MCP bridge serves to a node (WS-C §4.2): its
 *  OAuth-connectable HTTP servers, exactly the set the mcpx routes accept and
 *  /mcp connect offers. stdio, sse and plugin servers are not bridged. */
export function bridgedServerNames(
  personaId: string | null | undefined,
  globalMcp: ExternalMcp = currentGlobalMcp(),
  registry?: PersonaRegistry,
): string[] {
  return Object.keys(connectableServers(personaId, globalMcp, registry)).sort();
}

/** A `.mcp.json`-shaped value from effective state, as an ExternalMcp. A deep
 *  copy, so a session can never mutate the registry's snapshot, and NOT
 *  ${VAR}-expanded: the sync already resolved its placeholders, and expanding
 *  again would read gateway environment the persona never named. */
function fromEffective(cfg: unknown): ExternalMcp {
  if (!cfg || typeof cfg !== "object") return { servers: {}, privateServices: [] };
  const c = structuredClone(cfg) as { mcpServers?: unknown; privateServices?: unknown };
  const servers = (c.mcpServers && typeof c.mcpServers === "object" ? c.mcpServers : {}) as Record<string, McpServerConfig>;
  const list = Array.isArray(c.privateServices) ? c.privateServices.filter((n): n is string => typeof n === "string") : [];
  return { servers, privateServices: list.filter((n) => n in servers) };
}

/**
 * The external MCP config a session mounts, by persona and tenant source:
 *  - filesystem (unmanaged) registry: a named persona reads
 *    `personas/<name>/mcp.json`, the default persona the global `.mcp.json`
 *    (`globalMcp`) — exactly as before;
 *  - managed registry: never the persona directory. A named persona gets its
 *    effective mcp (git or override), nothing when it has none or is not live;
 *    the default persona its effective mcp when set, else the global
 *    `.mcp.json` (operator level, the same fallback the default soul has).
 */
export function sessionExternalMcp(
  personaId: string | null | undefined,
  globalMcp: ExternalMcp,
  registry: PersonaRegistry = getPersonaRegistry(),
): ExternalMcp {
  const named = personaId && personaId !== "default" ? personaId : undefined;
  if (!registry.isManaged()) return named ? loadExternalMcp(named) : globalMcp;
  if (named) {
    const mcp = registry.lookupByName(named)?.mcp;
    return mcp ? fromEffective(mcp) : { servers: {}, privateServices: [] };
  }
  const def = registry.defaultPersona?.()?.mcp;
  return def ? fromEffective(def) : globalMcp;
}
