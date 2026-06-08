import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";

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
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] ?? "");
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

/** Load + parse `~/.slaude/.mcp.json`. Missing file → empty result. */
export function loadExternalMcp(): ExternalMcp {
  const f = join(paths.home, ".mcp.json");
  if (!existsSync(f)) return { servers: {}, privateServices: [] };
  try {
    return parseExternalMcp(JSON.parse(readFileSync(f, "utf8")));
  } catch (err) {
    console.error(`[mcp] failed to load ${f}:`, err);
    return { servers: {}, privateServices: [] };
  }
}
