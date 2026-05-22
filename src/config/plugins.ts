// Load installed CC plugins so the SDK Query loads them via Options.plugins.
//
// `bun run install-deps` writes installed_plugins.json under
// $CLAUDE_CONFIG_DIR/plugins/. The SDK doesn't read that file on its own —
// it only loads plugins explicitly passed via Options.plugins (or settings
// when settingSources includes 'user'). We translate the metadata file into
// SDK plugin configs so each plugin's skills/commands surface in the session.
//
// LANDMINE: claude-agent-sdk 0.1.x ships a CLI that handles `--plugin-dir`
// (skills/commands/hooks/agents only) but does NOT mount the plugin's
// `.mcp.json` MCP servers. To work around it we also load each plugin's
// `.mcp.json` directly and surface them so the manager can merge them into
// Options.mcpServers.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "./home";

type InstalledPluginRecord = {
  scope?: string;
  installPath?: string;
};

type InstalledPluginsFile = {
  version?: number;
  plugins?: Record<string, InstalledPluginRecord[]>;
};

export type SdkPluginPath = { type: "local"; path: string };

function readInstalledPlugins(): InstalledPluginsFile | null {
  const file = join(paths.claudeConfig, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as InstalledPluginsFile;
  } catch {
    return null;
  }
}

export function loadInstalledPluginPaths(): SdkPluginPath[] {
  const parsed = readInstalledPlugins();
  if (!parsed) return [];
  const out: SdkPluginPath[] = [];
  const seen = new Set<string>();
  for (const records of Object.values(parsed.plugins ?? {})) {
    for (const r of records ?? []) {
      const p = r?.installPath;
      if (!p || seen.has(p)) continue;
      if (!existsSync(p)) continue;
      seen.add(p);
      out.push({ type: "local", path: p });
    }
  }
  return out;
}

type RawMcpEntry = Record<string, unknown>;

// `npx` ships with the Node toolchain; the bun runtime image only has `bunx`.
// Plugin .mcp.json files frequently assume Node and use `npx <pkg>` to launch a
// stdio server. Transparently rewrite to `bunx` so plugins authored for the
// generic Claude Code runtime still work under slaude's bun-only base image.
function shimStdioCommand(command: string): string {
  if (command === "npx") return "bunx";
  return command;
}

function coerceMcpServer(name: string, raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawMcpEntry;
  const type = typeof r.type === "string" ? r.type : undefined;
  if (type === "http" || type === "sse") {
    if (typeof r.url !== "string") return null;
    return { type, url: r.url, ...(r.headers && typeof r.headers === "object" ? { headers: r.headers as Record<string, string> } : {}) } as McpServerConfig;
  }
  if (typeof r.command === "string") {
    return {
      type: "stdio",
      command: shimStdioCommand(r.command),
      ...(Array.isArray(r.args) ? { args: r.args.map(String) } : {}),
      ...(r.env && typeof r.env === "object" ? { env: r.env as Record<string, string> } : {}),
    } as McpServerConfig;
  }
  return null;
}

export function loadInstalledPluginMcps(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const p of loadInstalledPluginPaths()) {
    const mcpFile = join(p.path, ".mcp.json");
    if (!existsSync(mcpFile)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(mcpFile, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (out[name]) continue;
      const cfg = coerceMcpServer(name, raw);
      if (cfg) out[name] = cfg;
    }
  }
  return out;
}
