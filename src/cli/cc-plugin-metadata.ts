// Pure helpers for Claude Code's plugin metadata files. Slaude install drops
// plugin files into the cache layout but CC only loads a plugin once it is
// also registered in:
//
//   $CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json
//   $CLAUDE_CONFIG_DIR/plugins/installed_plugins.json
//   $CLAUDE_CONFIG_DIR/settings.json   (enabledPlugins + extraKnownMarketplaces)
//
// These helpers are pure (input → output JSON value) so they're unit-testable
// without touching the filesystem.

export type McSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string; ref: string };

export function detectMarketplaceSource(marketplaceUrl: string, ref: string): McSource {
  const ghShort = marketplaceUrl.match(/^github:(.+?)(?:\.git)?$/);
  if (ghShort && ghShort[1]) return { source: "github", repo: ghShort[1] };
  const ghHttps = marketplaceUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ghHttps && ghHttps[1]) return { source: "github", repo: ghHttps[1] };
  return { source: "git", url: marketplaceUrl, ref };
}

// Last path segment of the URL, stripping .git, lowercased. Used only as a
// fallback when .claude-plugin/marketplace.json has no `name` field.
export function deriveMarketplaceSlug(marketplaceUrl: string): string {
  const m = marketplaceUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
  return (m?.[1] ?? marketplaceUrl).toLowerCase();
}

export interface KnownMarketplacesEntry {
  source: McSource;
  installLocation: string;
  lastUpdated: string;
}

export function mergeKnownMarketplace(
  existing: Record<string, KnownMarketplacesEntry>,
  slug: string,
  source: McSource,
  installLocation: string,
  now: string = new Date().toISOString(),
): Record<string, KnownMarketplacesEntry> {
  return {
    ...existing,
    [slug]: { source, installLocation, lastUpdated: now },
  };
}

export interface InstalledPluginRecord {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

export interface InstalledPluginsFile {
  version: 2;
  plugins: Record<string, InstalledPluginRecord[]>;
}

export function emptyInstalledPlugins(): InstalledPluginsFile {
  return { version: 2, plugins: {} };
}

export function mergeInstalledPlugin(
  existing: InstalledPluginsFile,
  pluginKey: string,
  installPath: string,
  version: string,
  gitCommitSha: string,
  now: string = new Date().toISOString(),
): InstalledPluginsFile {
  const prev = existing.plugins[pluginKey]?.[0];
  const next: InstalledPluginsFile = {
    version: 2,
    plugins: { ...existing.plugins },
  };
  next.plugins[pluginKey] = [{
    scope: "user",
    installPath,
    version,
    installedAt: prev?.installedAt ?? now,
    lastUpdated: now,
    gitCommitSha,
  }];
  return next;
}

export interface SettingsPatch {
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, { source: McSource }>;
  [k: string]: unknown;
}

export function mergeSettings(
  existing: SettingsPatch,
  enabledKeys: string[],
  marketplaces: Record<string, { source: McSource }>,
): SettingsPatch {
  const next: SettingsPatch = { ...existing };
  const enabled = { ...(next.enabledPlugins ?? {}) };
  for (const k of enabledKeys) enabled[k] = true;
  next.enabledPlugins = enabled;
  const extra = { ...(next.extraKnownMarketplaces ?? {}) };
  for (const [slug, m] of Object.entries(marketplaces)) extra[slug] = m;
  next.extraKnownMarketplaces = extra;
  return next;
}

// Build the conventional CC plugin key "<plugin>@<marketplace-slug>".
export function pluginKey(plugin: string, marketplaceSlug: string): string {
  return `${plugin}@${marketplaceSlug}`;
}
