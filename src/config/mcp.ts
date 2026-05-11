import { existsSync, readFileSync } from "node:fs";
import type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { paths } from "./home";

/**
 * External MCP server config types loadable from $SLAUDE_HOME/mcp.json.
 * SDK-instance servers (slaude_slack / slaude_skills) are mounted in code
 * by transport adapters — they are NOT loadable from this file.
 */
export type ExternalMcpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;

const RESERVED_NAMES = new Set(["slaude_slack", "slaude_skills"]);

/**
 * Expand `${VAR}` references inside a string against process.env. Missing
 * vars expand to "" (matches POSIX shell). Use sparingly — only for fields
 * that pass through unmodified to a child process / outbound HTTP header.
 */
function expand(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, k) => process.env[k] ?? "");
}

function expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return rec;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expand(v);
  return out;
}

function validate(name: string, raw: any): ExternalMcpServerConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`mcp.json: server ${name} must be an object`);
  }
  // HTTP / SSE require explicit type + url.
  if (raw.type === "http" || raw.type === "sse") {
    if (typeof raw.url !== "string" || !raw.url) {
      throw new Error(`mcp.json: server ${name} (${raw.type}) missing "url"`);
    }
    const cfg: McpHttpServerConfig | McpSSEServerConfig = {
      type: raw.type,
      url: expand(raw.url),
      ...(raw.headers ? { headers: expandRecord(raw.headers) } : {}),
    } as any;
    return cfg;
  }
  // Anything else → stdio. `type` field optional in stdio (per SDK).
  if (typeof raw.command !== "string" || !raw.command) {
    throw new Error(`mcp.json: server ${name} (stdio) missing "command"`);
  }
  if (raw.args !== undefined && !Array.isArray(raw.args)) {
    throw new Error(`mcp.json: server ${name}.args must be a string array`);
  }
  const cfg: McpStdioServerConfig = {
    type: "stdio",
    command: expand(raw.command),
    ...(raw.args ? { args: raw.args.map((a: unknown) => expand(String(a))) } : {}),
    ...(raw.env ? { env: expandRecord(raw.env) ?? {} } : {}),
  };
  return cfg;
}

/**
 * Read $SLAUDE_HOME/mcp.json (override path via SLAUDE_MCP_CONFIG) and return
 * a name → config map ready to spread into SDK `Options.mcpServers`. Missing
 * file → {}. Malformed JSON / bad schema → throw at boot (loud is good here).
 *
 * Reserved server names (slaude_slack, slaude_skills) are dropped with a
 * warning so user config can't shadow the in-process Slack output MCP.
 */
export function loadExternalMcp(
  path: string = process.env.SLAUDE_MCP_CONFIG || paths.mcp,
): Record<string, ExternalMcpServerConfig> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`mcp.json: invalid JSON at ${path}: ${e?.message ?? e}`);
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error(`mcp.json at ${path} must have a top-level "mcpServers" object`);
  }
  const out: Record<string, ExternalMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (RESERVED_NAMES.has(name)) {
      console.warn(`[mcp] ignoring reserved server name "${name}" in ${path}`);
      continue;
    }
    out[name] = validate(name, cfg);
  }
  return out;
}
