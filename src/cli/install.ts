// slaude install — dependency manifest installer.
// Usage: bun src/cli/install.ts [--update] [--frozen] [--check]
// Exit codes: 0 = ok, 1 = --check found drift, 2 = schema error, 3 = git/net error, 4 = marketplace error

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SLAUDE_HOME, paths } from "../config/home";
import {
  manifestSchema,
  lockfileSchema,
  type Manifest,
  type Lockfile,
} from "../config/manifest-schema";

function resolveGitUrl(raw: string): string {
  const m = raw.match(/^github:(.+)$/);
  if (m) return `https://github.com/${m[1]}.git`;
  return raw;
}

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

function resolveSlug(entry: { git: string; slug?: string }): string {
  if (entry.slug) return entry.slug;
  const last = entry.git.split("/").pop() ?? "";
  return last.replace(/\.git$/, "").toLowerCase();
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
      const slug = resolveSlug(e);
      if (!lock.skills[slug]) unsatisfied.push(`skill ${slug}`);
    }
    for (const e of manifest.knowledge) {
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
      const slug = resolveSlug(e);
      if (!lock.skills[slug]) missing.push(`skill ${slug}`);
    }
    for (const e of manifest.knowledge) {
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

  for (const [key, entry] of mpEntries) {
    const lockEntry = lock.marketplaces[key];
    const mpDir = join(paths.claudeConfig, "plugins", "cache", sanitizePathSegment(entry.marketplace));
    const resolvedUrl = resolveGitUrl(entry.marketplace);

    // Clone marketplace if needed
    const mpCloneDir = join(mpDir, "_repo");
    let sha = lockEntry?.sha ?? "";
    const needsClone = !lockEntry || !existsSync(mpCloneDir) || (() => {
      try { return currentSha(mpCloneDir) !== sha; } catch { return true; }
    })();

    if (needsClone || update) {
      if (existsSync(mpCloneDir)) rmSync(mpCloneDir, { recursive: true, force: true });
      sha = gitClone(resolvedUrl, entry.ref, mpCloneDir);
      installed++;
    } else {
      skipped++;
    }

    // Read marketplace.json
    const mpJsonPath = join(mpCloneDir, "marketplace.json");
    if (!existsSync(mpJsonPath)) {
      console.error(`[install] marketplace.json missing in ${key}`);
      process.exit(4);
    }
    let mpJson: { plugins: Array<{ name: string; version: string; path?: string }> };
    try {
      mpJson = JSON.parse(readFileSync(mpJsonPath, "utf8"));
    } catch (e: any) {
      console.error(`[install] unreadable marketplace.json in ${key}:`, e?.message ?? e);
      process.exit(4);
    }

    const mpPlugins: Record<string, { version: string; subdir: string }> = {};
    for (const pn of entry.plugins) {
      const mpPlugin = mpJson.plugins.find((p) => p.name === pn);
      if (!mpPlugin) {
        const available = mpJson.plugins.map((p) => p.name).join(", ") || "(none)";
        console.error(`[install] plugin "${pn}" not found in ${key}. Available: ${available}`);
        process.exit(4);
      }
      const versionDir = sanitizePathSegment(mpPlugin.version);
      const targetDir = join(mpDir, sanitizePathSegment(pn), versionDir);
      const srcDir = mpPlugin.path ? join(mpCloneDir, mpPlugin.path) : mpCloneDir;

      if (!existsSync(targetDir) || update) {
        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetDir, { recursive: true });
        // Copy plugin files
        for (const file of readdirSync(srcDir)) {
          const s = join(srcDir, file);
          const d = join(targetDir, file);
          if (statSync(s).isDirectory()) {
            execSync(`cp -r ${s} ${d}`);
          } else {
            writeFileSync(d, readFileSync(s));
          }
        }
        if (!needsClone) installed++;
      }
      mpPlugins[pn] = { version: mpPlugin.version, subdir: mpPlugin.path ?? "." };
    }
    lock.marketplaces[key] = { sha, plugins: mpPlugins };
  }

  // --- Skills ---
  for (const e of manifest.skills) {
    const slug = resolveSlug(e);
    const lockEntry = lock.skills[slug];
    const targetDir = join(paths.skills, slug);
    const resolvedUrl = resolveGitUrl(e.git);

    const needsClone = !lockEntry || !existsSync(targetDir) || (() => {
      try { return currentSha(targetDir) !== lockEntry.sha; } catch { return true; }
    })();

    if (needsClone || update) {
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      const sha = gitClone(resolvedUrl, e.ref, targetDir);
      lock.skills[slug] = { git: e.git, ref: e.ref, sha };
      installed++;
      if (!existsSync(join(targetDir, "SKILL.md"))) {
        console.warn(`[install] skill "${slug}" has no SKILL.md at root — will be skipped at runtime`);
      }
    } else {
      skipped++;
    }
  }

  // --- Knowledge ---
  for (const e of manifest.knowledge) {
    const lockEntry = lock.knowledge[e.label];
    const targetDir = join(paths.knowledge, e.label);
    const resolvedUrl = resolveGitUrl(e.git);

    const needsClone = !lockEntry || !existsSync(targetDir) || (() => {
      try { return currentSha(targetDir) !== lockEntry.sha; } catch { return true; }
    })();

    if (needsClone || update) {
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      const sha = gitClone(resolvedUrl, e.ref, targetDir);
      lock.knowledge[e.label] = { git: e.git, ref: e.ref, sha };
      installed++;
      const hasIndex = existsSync(join(targetDir, "README.md")) || existsSync(join(targetDir, "index.md"));
      if (!hasIndex) {
        console.warn(`[install] knowledge "${e.label}" has no README.md or index.md — will be skipped at runtime`);
      }
    } else {
      skipped++;
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

void main();
