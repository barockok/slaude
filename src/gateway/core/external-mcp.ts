import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";

/** Return a copy of a server config with all injected secrets removed.
 *  stdio → env emptied; sse/http → headers emptied + url userinfo/query stripped.
 *  command/args and url host/path are preserved so the server still launches/reaches
 *  its endpoint — just anonymous. The input is never mutated. */
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
 *  are warned-about and dropped. `env` is injectable for testing. */
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
