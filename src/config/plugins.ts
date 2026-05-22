// Load installed CC plugins so the SDK Query loads them via Options.plugins.
//
// `bun run install-deps` writes installed_plugins.json under
// $CLAUDE_CONFIG_DIR/plugins/. The SDK doesn't read that file on its own —
// it only loads plugins explicitly passed via Options.plugins (or settings
// when settingSources includes 'user'). We translate the metadata file into
// SDK plugin configs so each plugin's skills/commands/.mcp.json surface in
// the session.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function loadInstalledPluginPaths(): SdkPluginPath[] {
  const file = join(paths.claudeConfig, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return [];
  let parsed: InstalledPluginsFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as InstalledPluginsFile;
  } catch {
    return [];
  }
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
