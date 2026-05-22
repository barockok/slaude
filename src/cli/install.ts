// slaude install — dependency manifest installer.
// Usage: bun src/cli/install.ts [--update] [--frozen] [--check]
// Exit codes: 0 = ok, 1 = --check found drift, 2 = schema error, 3 = git/net error, 4 = marketplace error

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SLAUDE_HOME, paths } from "../config/home";
import {
  manifestSchema,
  lockfileSchema,
  resolveGitUrl,
  resolveSkillSlug,
  type Manifest,
  type Lockfile,
} from "../config/manifest-schema";
import {
  detectMarketplaceSource,
  deriveMarketplaceSlug,
  emptyInstalledPlugins,
  mergeInstalledPlugin,
  mergeKnownMarketplace,
  mergeSettings,
  pluginKey,
  type InstalledPluginsFile,
  type KnownMarketplacesEntry,
  type McSource,
  type SettingsPatch,
} from "./cc-plugin-metadata";

function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[:\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function gitClone(url: string, ref: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  if (isSha(ref)) {
    execSync(`git clone --filter=tree:0 --no-checkout ${url} ${targetDir}`, {
      stdio: "pipe",
    });
    execSync(`git checkout ${ref}`, { cwd: targetDir, stdio: "pipe" });
  } else {
    execSync(`git clone --depth 1 --branch ${ref} ${url} ${targetDir}`, {
      stdio: "pipe",
    });
  }
  return execSync("git rev-parse HEAD", { cwd: targetDir, encoding: "utf8" }).trim();
}

function currentSha(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

async function main() {
  const args = Bun.argv.slice(2);
  const update = args.includes("--update");
  const frozen = args.includes("--frozen");
  const check = args.includes("--check");

  const manifestPath = join(SLAUDE_HOME, "slaude.json");
  if (!existsSync(manifestPath)) {
    console.log("[install] no slaude.json — nothing to install");
    process.exit(0);
  }

  let manifest: Manifest;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    manifest = manifestSchema.parse(JSON.parse(raw));
  } catch (e: any) {
    console.error("[install] invalid slaude.json:", e?.message ?? e);
    process.exit(2);
  }

  const lockPath = join(SLAUDE_HOME, "slaude.lock");
  let lock: Lockfile = {
    version: 1 as const,
    generated_at: new Date().toISOString(),
    marketplaces: {},
    skills: {},
    knowledge: {},
  };
  if (!update && existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf8");
      lock = lockfileSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("[install] unreadable lockfile — treating as empty");
    }
  }

  // --check: exit 0 if lock satisfies manifest, exit 1 if not
  if (check) {
    const unsatisfied: string[] = [];
    for (const e of manifest.plugins) {
      const key = `${e.marketplace}@${e.ref}`;
      if (!lock.marketplaces[key]?.plugins[e.plugin]) unsatisfied.push(`plugin ${e.plugin} from ${key}`);
    }
    for (const e of manifest.skills) {
      if (!e.git) continue;
      const slug = resolveSkillSlug(e);
      if (!lock.skills[slug]) unsatisfied.push(`skill ${slug}`);
    }
    for (const e of manifest.knowledge) {
      if (!e.git) continue;
      if (!lock.knowledge[e.label]) unsatisfied.push(`knowledge ${e.label}`);
    }
    if (unsatisfied.length) {
      console.error("[install] unsatisfied entries:");
      for (const u of unsatisfied) console.error(`  - ${u}`);
      process.exit(1);
    }
    console.log("[install] lockfile satisfied");
    process.exit(0);
  }

  // --frozen: fail if any entry not in lockfile (before doing work)
  if (frozen) {
    const missing: string[] = [];
    for (const e of manifest.plugins) {
      const key = `${e.marketplace}@${e.ref}`;
      if (!lock.marketplaces[key]?.plugins[e.plugin]) missing.push(`plugin ${e.plugin} from ${key}`);
    }
    for (const e of manifest.skills) {
      if (!e.git) continue;
      const slug = resolveSkillSlug(e);
      if (!lock.skills[slug]) missing.push(`skill ${slug}`);
    }
    for (const e of manifest.knowledge) {
      if (!e.git) continue;
      if (!lock.knowledge[e.label]) missing.push(`knowledge ${e.label}`);
    }
    if (missing.length) {
      console.error("[install] --frozen: the following entries are not in slaude.lock:");
      for (const m of missing) console.error(`  - ${m}`);
      console.error("Run with --update to resolve and regenerate the lockfile.");
      process.exit(3);
    }
  }

  // --update: clear lock so everything resolves fresh
  if (update) {
    lock = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      marketplaces: {},
      skills: {},
      knowledge: {},
    };
  }

  let installed = 0;
  let skipped = 0;

  // --- Plugins ---
  // Dedupe by (marketplace, ref) so one clone serves many plugins from the same marketplace
  const mpEntries = new Map<string, { marketplace: string; ref: string; plugins: string[] }>();
  for (const e of manifest.plugins) {
    const key = `${e.marketplace}@${e.ref}`;
    if (!mpEntries.has(key)) mpEntries.set(key, { marketplace: e.marketplace, ref: e.ref, plugins: [] });
    mpEntries.get(key)!.plugins.push(e.plugin);
  }

  // Aggregate metadata across all marketplaces this run so we write the
  // CC plugin config files exactly once at the end.
  const ccEnabledKeys: string[] = [];
  const ccMarketplaces: Record<string, { source: McSource }> = {};
  const ccKnownMarketplacesUpdates: Array<[string, KnownMarketplacesEntry]> = [];
  const ccInstalledPluginUpdates: Array<{
    pluginKey: string;
    installPath: string;
    version: string;
    sha: string;
  }> = [];

  for (const [key, entry] of mpEntries) {
    const lockEntry = lock.marketplaces[key];
    const resolvedUrl = resolveGitUrl(entry.marketplace);

    // Always clone into a tmp dir first — we don't know the canonical marketplace
    // slug (from marketplace.json `name`) until we've read the index.
    const stagingClone = mkdtempSync(join(tmpdir(), "slaude-mp-"));
    let sha: string;
    try {
      sha = gitClone(resolvedUrl, entry.ref, stagingClone);
    } catch (e: any) {
      rmSync(stagingClone, { recursive: true, force: true });
      console.error(`[install] git clone failed for ${key}:`, e?.message ?? e);
      process.exit(3);
    }

    // Read marketplace.json — prefer Claude Code's .claude-plugin/marketplace.json,
    // fall back to root-level marketplace.json (slaude design doc shape).
    const mpJsonCandidates = [
      join(stagingClone, ".claude-plugin", "marketplace.json"),
      join(stagingClone, "marketplace.json"),
    ];
    const mpJsonPath = mpJsonCandidates.find((p) => existsSync(p));
    if (!mpJsonPath) {
      rmSync(stagingClone, { recursive: true, force: true });
      console.error(`[install] marketplace.json missing in ${key} (looked at .claude-plugin/marketplace.json and marketplace.json)`);
      process.exit(4);
    }
    // Accept either { path, version } (slaude shape) or { source } (CC shape).
    // version is optional; falls back to the marketplace ref so cache layout stays deterministic.
    let mpJson: {
      name?: string;
      plugins: Array<{ name: string; version?: string; path?: string; source?: string }>;
    };
    try {
      mpJson = JSON.parse(readFileSync(mpJsonPath, "utf8"));
    } catch (e: any) {
      rmSync(stagingClone, { recursive: true, force: true });
      console.error(`[install] unreadable marketplace.json in ${key}:`, e?.message ?? e);
      process.exit(4);
    }

    // Canonical marketplace slug — used in cache paths AND the CC plugin key
    // (`<plugin>@<slug>`). Prefer marketplace.json `name`; fall back to URL.
    const mpSlug = mpJson.name?.trim() || deriveMarketplaceSlug(entry.marketplace);
    const mpInstallLocation = join(paths.claudeConfig, "plugins", "marketplaces", mpSlug);
    const mpCacheDir = join(paths.claudeConfig, "plugins", "cache", mpSlug);

    // Move staging clone to its final marketplaces/ location.
    mkdirSync(join(paths.claudeConfig, "plugins", "marketplaces"), { recursive: true });
    if (existsSync(mpInstallLocation)) rmSync(mpInstallLocation, { recursive: true, force: true });
    renameSync(stagingClone, mpInstallLocation);
    installed++;

    const mpPlugins: Record<string, { version: string; subdir: string }> = {};
    for (const pn of entry.plugins) {
      const mpPlugin = mpJson.plugins.find((p) => p.name === pn);
      if (!mpPlugin) {
        const available = mpJson.plugins.map((p) => p.name).join(", ") || "(none)";
        console.error(`[install] plugin "${pn}" not found in ${key}. Available: ${available}`);
        process.exit(4);
      }
      const subdir =
        mpPlugin.path ??
        (typeof mpPlugin.source === "string" ? mpPlugin.source.replace(/^\.\//, "") : undefined);
      const version = mpPlugin.version ?? entry.ref;
      const versionDir = sanitizePathSegment(version);
      const targetDir = join(mpCacheDir, sanitizePathSegment(pn), versionDir);
      const srcDir = subdir ? join(mpInstallLocation, subdir) : mpInstallLocation;

      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });
      for (const file of readdirSync(srcDir)) {
        const s = join(srcDir, file);
        const d = join(targetDir, file);
        if (statSync(s).isDirectory()) {
          execSync(`cp -r "${s}" "${d}"`, { stdio: "pipe" });
        } else {
          writeFileSync(d, readFileSync(s));
        }
      }
      mpPlugins[pn] = { version, subdir: subdir ?? "." };

      const pKey = pluginKey(pn, mpSlug);
      ccEnabledKeys.push(pKey);
      ccInstalledPluginUpdates.push({
        pluginKey: pKey,
        installPath: targetDir,
        version,
        sha,
      });
    }
    lock.marketplaces[key] = { sha, plugins: mpPlugins };

    const source = detectMarketplaceSource(entry.marketplace, entry.ref);
    ccMarketplaces[mpSlug] = { source };
    ccKnownMarketplacesUpdates.push([mpSlug, { source, installLocation: mpInstallLocation, lastUpdated: new Date().toISOString() }]);
  }

  // Write the three CC plugin metadata files (merge with whatever the operator
  // or a previous run wrote so we don't clobber unrelated plugins / settings).
  if (mpEntries.size > 0) writeCcPluginMetadata({
    knownMarketplacesUpdates: ccKnownMarketplacesUpdates,
    installedPluginUpdates: ccInstalledPluginUpdates,
    settingsEnabledKeys: ccEnabledKeys,
    settingsMarketplaces: ccMarketplaces,
  });

  // --- Skills + Knowledge ---
  // Dedupe by (git, ref) so one clone serves many entries from the same repo.
  type GitEntry = { git: string; ref: string; path?: string };
  const skillGitEntries = new Map<string, { resolvedUrl: string; ref: string; skills: { entry: typeof manifest.skills[number]; slug: string; entryPath: string }[] }>();
  for (const e of manifest.skills) {
    if (!e.git) { skipped++; continue; }
    const slug = resolveSkillSlug(e);
    const key = `${e.git}@${e.ref}`;
    if (!skillGitEntries.has(key)) {
      skillGitEntries.set(key, { resolvedUrl: resolveGitUrl(e.git), ref: e.ref!, skills: [] });
    }
    skillGitEntries.get(key)!.skills.push({ entry: e, slug, entryPath: e.path ?? slug });
  }

  const kbGitEntries = new Map<string, { resolvedUrl: string; ref: string; kbs: { entry: typeof manifest.knowledge[number]; label: string; entryPath: string }[] }>();
  for (const e of manifest.knowledge) {
    if (!e.git) { skipped++; continue; }
    const key = `${e.git}@${e.ref}`;
    if (!kbGitEntries.has(key)) {
      kbGitEntries.set(key, { resolvedUrl: resolveGitUrl(e.git), ref: e.ref!, kbs: [] });
    }
    kbGitEntries.get(key)!.kbs.push({ entry: e, label: e.label, entryPath: e.path ?? e.label });
  }

  // Clone each skill repo once, fan out entries by path
  for (const [, group] of skillGitEntries) {
    const lockEntry = group.skills[0] ? lock.skills[resolveSkillSlug(group.skills[0].entry)] : undefined;
    const cloneDir = mkdtempSync(join(tmpdir(), "slaude-install-"));
    try {
      const sha = gitClone(group.resolvedUrl, group.ref, cloneDir);
      for (const { entry, slug, entryPath } of group.skills) {
        const targetDir = join(paths.skills, slug);
        const srcDir = join(cloneDir, entryPath);
        if (!existsSync(srcDir)) {
          console.warn(`[install] skill "${slug}" path "${entryPath}" not found in repo — skipping`);
          skipped++;
          continue;
        }
        const alreadyOk = !update && existsSync(targetDir) && (() => {
          try { return lockEntry?.sha === sha; } catch { return false; }
        })();
        if (alreadyOk) { skipped++; continue; }
        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetDir, { recursive: true });
        for (const file of readdirSync(srcDir)) {
          const s = join(srcDir, file);
          const d = join(targetDir, file);
          if (statSync(s).isDirectory()) {
            execSync(`cp -r "${s}" "${d}"`, { stdio: "pipe" });
          } else {
            writeFileSync(d, readFileSync(s));
          }
        }
        lock.skills[slug] = { git: entry.git!, ref: entry.ref!, sha, path: entryPath };
        installed++;
        if (!existsSync(join(targetDir, "SKILL.md"))) {
          console.warn(`[install] skill "${slug}" has no SKILL.md at path "${entryPath}" — will be skipped at runtime`);
        }
      }
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  }

  // Clone each KB repo once, fan out entries by path
  for (const [, group] of kbGitEntries) {
    const lockEntry = group.kbs[0] ? lock.knowledge[group.kbs[0].label] : undefined;
    const cloneDir = mkdtempSync(join(tmpdir(), "slaude-install-"));
    try {
      const sha = gitClone(group.resolvedUrl, group.ref, cloneDir);
      for (const { entry, label, entryPath } of group.kbs) {
        const targetDir = join(paths.knowledge, label);
        const srcDir = join(cloneDir, entryPath);
        if (!existsSync(srcDir)) {
          console.warn(`[install] knowledge "${label}" path "${entryPath}" not found in repo — skipping`);
          skipped++;
          continue;
        }
        const alreadyOk = !update && existsSync(targetDir) && (() => {
          try { return lockEntry?.sha === sha; } catch { return false; }
        })();
        if (alreadyOk) { skipped++; continue; }
        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetDir, { recursive: true });
        for (const file of readdirSync(srcDir)) {
          const s = join(srcDir, file);
          const d = join(targetDir, file);
          if (statSync(s).isDirectory()) {
            execSync(`cp -r "${s}" "${d}"`, { stdio: "pipe" });
          } else {
            writeFileSync(d, readFileSync(s));
          }
        }
        lock.knowledge[label] = { git: entry.git!, ref: entry.ref!, sha, path: entryPath };
        installed++;
        const hasIndex = existsSync(join(targetDir, "README.md")) || existsSync(join(targetDir, "index.md"));
        if (!hasIndex) {
          console.warn(`[install] knowledge "${label}" has no README.md or index.md at path "${entryPath}" — will be skipped at runtime`);
        }
      }
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  }

  // Write lockfile atomically
  lock.generated_at = new Date().toISOString();
  const tmpPath = lockPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  renameSync(tmpPath, lockPath);

  const total = manifest.plugins.length + manifest.skills.length + manifest.knowledge.length;
  console.log(`[install] ${total} entries: ${installed} installed, ${skipped} skipped (${manifest.plugins.length} plugins / ${manifest.skills.length} skills / ${manifest.knowledge.length} KBs)`);
}

interface CcMetadataInput {
  knownMarketplacesUpdates: Array<[string, KnownMarketplacesEntry]>;
  installedPluginUpdates: Array<{ pluginKey: string; installPath: string; version: string; sha: string }>;
  settingsEnabledKeys: string[];
  settingsMarketplaces: Record<string, { source: McSource }>;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function readJsonOr<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return fallback; }
}

function writeCcPluginMetadata(input: CcMetadataInput): void {
  const pluginsDir = join(paths.claudeConfig, "plugins");
  mkdirSync(pluginsDir, { recursive: true });

  // known_marketplaces.json
  const kmPath = join(pluginsDir, "known_marketplaces.json");
  let known = readJsonOr<Record<string, KnownMarketplacesEntry>>(kmPath, {});
  for (const [slug, entry] of input.knownMarketplacesUpdates) {
    known = mergeKnownMarketplace(known, slug, entry.source, entry.installLocation, entry.lastUpdated);
  }
  writeJsonAtomic(kmPath, known);

  // installed_plugins.json
  const ipPath = join(pluginsDir, "installed_plugins.json");
  let installedPlugins = readJsonOr<InstalledPluginsFile>(ipPath, emptyInstalledPlugins());
  if (installedPlugins.version !== 2 || !installedPlugins.plugins) installedPlugins = emptyInstalledPlugins();
  for (const u of input.installedPluginUpdates) {
    installedPlugins = mergeInstalledPlugin(installedPlugins, u.pluginKey, u.installPath, u.version, u.sha);
  }
  writeJsonAtomic(ipPath, installedPlugins);

  // settings.json — merge enabledPlugins + extraKnownMarketplaces. Preserve all
  // other keys the operator may have written (permissions, model, hooks, etc.).
  const settingsPath = join(paths.claudeConfig, "settings.json");
  const settings = readJsonOr<SettingsPatch>(settingsPath, {});
  const merged = mergeSettings(settings, input.settingsEnabledKeys, input.settingsMarketplaces);
  writeJsonAtomic(settingsPath, merged);
}

void main();
