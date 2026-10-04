import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";
import { isGatewayOnlyEnv } from "../../config/gateway-only-env";
import { getPersonaRegistry, type PersonaRegistry } from "../../persona/registry";
import { env } from "../../config/env";

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
  opts: { allow?: ReadonlySet<string>; onUnlisted?: (name: string) => void } = {},
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
      // The MCP bridge's file opt-in: only operator-allowlisted names expand.
      if (opts.allow && !opts.allow.has(name)) {
        opts.onUnlisted?.(name);
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
 *  `sessionExternalMcp` in the file; a function declaration, so order is moot.
 *
 *  In the gateway role the sessions run on nodes and reach these servers only
 *  through the MCP bridge, so the list (and the config a connect keys its
 *  credential on) is the bridge's own source: a server the bridge would not
 *  serve is not offered, and the credential key matches the one the bridge
 *  looks up. mono keeps its own mounts. */
export function connectableServers(
  personaId: string | null | undefined,
  globalMcp: ExternalMcp,
  registry?: PersonaRegistry,
  opts: { role?: string; bridge?: BridgeSourceOptions } = {},
): ReturnType<typeof oauthHttpServers> {
  if ((opts.role ?? env.role()) === "gateway") {
    return oauthHttpServers(bridgeExternalMcp(personaId, { ...(registry ? { registry } : {}), ...opts.bridge }).servers);
  }
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

// ── the MCP bridge's source of server configs (WS-C §4.2) ───────────────────

export interface BridgeSourceOptions {
  registry?: PersonaRegistry;
  /** Serve servers defined by FILES on $SLAUDE_HOME. Default:
   *  SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG=1. */
  allowFileConfig?: boolean;
  /** With the file opt-in, the only `${VAR}` names expanded. Default:
   *  SLAUDE_MCP_BRIDGE_ENV_ALLOW (empty). */
  envAllow?: readonly string[];
  env?: Record<string, string | undefined>;
}

/** SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG: unset/0 = off, 1 = on, else refused. */
export function bridgeAllowsFileConfig(raw = process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG): boolean {
  const v = (raw ?? "").trim();
  if (v === "" || v === "0") return false;
  if (v === "1") return true;
  throw new Error(`SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG must be 0 or 1 (got '${v}')`);
}

/** SLAUDE_MCP_BRIDGE_ENV_ALLOW: a comma list of variable names. */
export const bridgeEnvAllow = (raw = process.env.SLAUDE_MCP_BRIDGE_ENV_ALLOW): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const fileCache = new Map<string, { stamp: string; value: ExternalMcp }>();
const warnedUnlisted = new Set<string>();

/** A config FILE read for the bridge: `${VAR}` expands only for allowlisted
 *  names (on top of the gateway-only refusal); any other placeholder stays as
 *  written and its NAME is logged once. Re-read only when the file changes. */
function bridgeFileMcp(path: string, allow: readonly string[], env: Record<string, string | undefined>): ExternalMcp {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}:${[...allow].sort().join(",")}`;
  } catch {
    fileCache.delete(path);
    return { servers: {}, privateServices: [] };
  }
  const hit = fileCache.get(path);
  if (hit && hit.stamp === stamp) return structuredClone(hit.value);
  let value: ExternalMcp = { servers: {}, privateServices: [] };
  try {
    value = parseExternalMcp(JSON.parse(readFileSync(path, "utf8")), env, {
      allow: new Set(allow),
      onUnlisted: (name) => {
        if (warnedUnlisted.has(name)) return;
        warnedUnlisted.add(name);
        console.warn(`[mcp-bridge] a server config references \${${name}}, which is not in SLAUDE_MCP_BRIDGE_ENV_ALLOW; left unexpanded`);
      },
    });
  } catch (err) {
    console.error(`[mcp-bridge] failed to load ${path}: ${err instanceof Error ? err.name : typeof err}`);
  }
  fileCache.set(path, { stamp, value });
  return structuredClone(value);
}

/**
 * The servers the MCP bridge may serve for a persona, and only those.
 *
 * $SLAUDE_HOME is the volume agents write to, so a config FILE there (the
 * global `.mcp.json`, `personas/<name>/mcp.json`) is not trusted to name where
 * the gateway sends credentials. By default the bridge serves only the MANAGED
 * persona's config: resolved at sync, stored encrypted in the database, out of
 * an agent's reach. Files are served only with the operator's opt-in
 * (SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG=1), and then expand only the
 * `${VAR}` names in SLAUDE_MCP_BRIDGE_ENV_ALLOW.
 */
export function bridgeExternalMcp(personaId: string | null | undefined, opts: BridgeSourceOptions = {}): ExternalMcp {
  const registry = opts.registry ?? getPersonaRegistry();
  const named = personaId && personaId !== "default" ? personaId : undefined;
  if (registry.isManaged()) {
    const mcp = named ? registry.lookupByName(named)?.mcp : registry.defaultPersona?.()?.mcp;
    if (mcp) return fromEffective(mcp);
    if (named) return { servers: {}, privateServices: [] };
    // The managed default persona without its own mcp falls back to the global file.
  }
  if (!(opts.allowFileConfig ?? bridgeAllowsFileConfig())) return { servers: {}, privateServices: [] };
  const path = named ? join(paths.personas, named.toLowerCase(), "mcp.json") : join(paths.home, ".mcp.json");
  return bridgeFileMcp(path, opts.envAllow ?? bridgeEnvAllow(), opts.env ?? process.env);
}

/** The persona's servers the MCP bridge serves to a node: the HTTP servers of
 *  {@link bridgeExternalMcp}, exactly the set the mcpx routes accept. stdio, sse
 *  and plugin servers are not bridged. */
export function bridgedServerNames(personaId: string | null | undefined, opts: BridgeSourceOptions = {}): string[] {
  return Object.keys(oauthHttpServers(bridgeExternalMcp(personaId, opts).servers)).sort();
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
