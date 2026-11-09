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
  version?: string;
  gitCommitSha?: string;
};

type InstalledPluginsFile = {
  version?: number;
  plugins?: Record<string, InstalledPluginRecord[]>;
};

export type SdkPluginPath = { type: "local"; path: string };

/** One installed plugin, as a metadata file records it. */
export interface InstalledPlugin {
  /** `<plugin>@<marketplace>`, the key in installed_plugins.json. */
  key: string;
  name: string;
  marketplace: string;
  path: string;
  version: string | null;
  commit: string | null;
  /** The installed_plugins.json that lists it. */
  listedIn: string;
  /** Listed under SLAUDE_PLUGIN_ROOT (baked into the image), not $SLAUDE_HOME. */
  imageOwned: boolean;
}

/**
 * The image-owned plugin location (SLAUDE_PLUGIN_ROOT), or null when unset. It
 * mirrors a CC config directory: `<root>/plugins/installed_plugins.json` and
 * `<root>/plugins/cache/...`. Unlike $SLAUDE_HOME it is not writable by agent
 * turns, which is what makes reporting a plugin's HTTP server safe (see
 * src/node/plugin-report.ts).
 */
export function pluginRoot(): string | null {
  return process.env.SLAUDE_PLUGIN_ROOT?.trim() || null;
}

function readInstalledPlugins(file: string): InstalledPluginsFile | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as InstalledPluginsFile;
  } catch {
    return null;
  }
}

/** Every installed plugin that exists on disk: the image-owned root first, then
 *  $SLAUDE_HOME/.claude/plugins. A key the root lists shadows the same key in
 *  $SLAUDE_HOME, so the volume cannot replace an image-owned plugin. */
export function listInstalledPlugins(): InstalledPlugin[] {
  const root = pluginRoot();
  const sources: Array<{ file: string; imageOwned: boolean }> = [
    ...(root ? [{ file: join(root, "plugins", "installed_plugins.json"), imageOwned: true }] : []),
    { file: join(paths.claudeConfig, "plugins", "installed_plugins.json"), imageOwned: false },
  ];
  const out: InstalledPlugin[] = [];
  const seenPaths = new Set<string>();
  const rootKeys = new Set<string>();
  for (const { file, imageOwned } of sources) {
    const parsed = readInstalledPlugins(file);
    for (const [key, records] of Object.entries(parsed?.plugins ?? {})) {
      if (!imageOwned && rootKeys.has(key)) continue;
      const at = key.lastIndexOf("@");
      for (const r of records ?? []) {
        const p = r?.installPath;
        if (!p || seenPaths.has(p)) continue;
        if (!existsSync(p)) continue;
        seenPaths.add(p);
        if (imageOwned) rootKeys.add(key);
        out.push({
          key,
          name: at > 0 ? key.slice(0, at) : key,
          marketplace: at > 0 ? key.slice(at + 1) : "",
          path: p,
          version: r.version ?? null,
          commit: r.gitCommitSha ?? null,
          listedIn: file,
          imageOwned,
        });
      }
    }
  }
  return out;
}

export function loadInstalledPluginPaths(): SdkPluginPath[] {
  return listInstalledPlugins().map((p) => ({ type: "local", path: p.path }));
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
