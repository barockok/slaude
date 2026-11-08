import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { isBuiltinSkillName } from "../soul/builtin";

/**
 * Bundled skills ship in the repo under `<repoRoot>/skills/<slug>/SKILL.md` and
 * are seeded into `$SLAUDE_HOME/skills/` on boot. `src/skills/seed.ts` →
 * repo root is two levels up (`../../`), so the bundled dir is `../../skills`.
 */
const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");

/** The slugs the release bundles (whether or not they were seeded here): a
 *  skill with one of these slugs is provenance `bundled` (provenance.ts). */
export function bundledSkillSlugs(bundledDir: string = BUNDLED_SKILLS_DIR): Set<string> {
  const out = new Set<string>();
  if (!existsSync(bundledDir)) return out;
  for (const slug of readdirSync(bundledDir)) {
    try {
      if (statSync(join(bundledDir, slug)).isDirectory() && existsSync(join(bundledDir, slug, "SKILL.md"))) out.add(slug);
    } catch {
      // unreadable entry: not a bundled skill
    }
  }
  return out;
}

/**
 * The sha256 of every SKILL.md a release shipped for a bundled slug before the
 * current one (from git history). A copy with no manifest entry that hashes
 * to one of these is an untouched older release copy, so it is refreshed;
 * anything else is treated as customised and left alone. Add the outgoing
 * hash here whenever a bundled SKILL.md changes.
 */
export const PRIOR_BUNDLED_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  "how-slaude-works": [
    "5e1e6e23b091f41953bb6a7fe3066ee3d2f7f4805f669a67464ba7f2b0032d91", // 41597d41
    "0559c3fd8d44b1fa0b06eb8ec756c3f00ff2209d1cff34d3f70a12a0aaa3367f", // 69c11f71
  ],
};

/**
 * What the seeder last wrote for each bundled slug: the sha256 of its SKILL.md.
 * A dot file in the skills root (the loader skips dot entries). A copy whose
 * SKILL.md still hashes to this was never edited, so a newer release may
 * replace it.
 */
const manifestPath = () => join(paths.skills, ".bundled.json");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const SHA_RE = /^[0-9a-f]{64}$/;

/** The manifest, keeping only well-formed entries; a file that does not parse is reported and read as empty. */
function readManifest(): Record<string, string> {
  const path = manifestPath();
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.warn(`[skills] ${path} could not be read, treating it as empty: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    console.warn(`[skills] ${path} is not an object, treating it as empty`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, h] of Object.entries(v as Record<string, unknown>)) if (typeof h === "string" && SHA_RE.test(h)) out[k] = h;
  return out;
}

/** Write a file through a temp file in the same directory and a rename, so a reader never sees it half written. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** The memory tools' pre-rename names (still mounted as aliases); only mentioned in the customised-copy log. */
const DEPRECATED_MEMORY_TOOLS = /\bkb_(search|think|memoize)\b/;

/** Slugs already reported as customised by this process. */
const reportedCustomised = new Set<string>();

export interface SeedOptions {
  /** Test seam: the prior shipped hashes per slug (default PRIOR_BUNDLED_VERSIONS). */
  priorVersions?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Copy any bundled skill that isn't already present into $SLAUDE_HOME/skills,
 * and bring an untouched older copy up to the bundled version.
 *
 * An installed copy is replaced only when its SKILL.md is exactly what a
 * release shipped: the hash the seeder recorded when it wrote it, or, for a
 * copy seeded before that record existed, one of the known prior versions
 * (PRIOR_BUNDLED_VERSIONS). Anything else is customised (an operator edit,
 * `write_skill`) and wins. A skill directory or SKILL.md that is a symlink, or
 * not a plain directory and file, is never written through. A refresh
 * replaces SKILL.md, the one file the bundled skills ship, atomically.
 * Best-effort: a failure here must not block boot, so errors are logged and
 * swallowed.
 */
export function seedBundledSkills(bundledDir: string = BUNDLED_SKILLS_DIR, opts: SeedOptions = {}): { seeded: string[]; refreshed: string[] } {
  const prior = opts.priorVersions ?? PRIOR_BUNDLED_VERSIONS;
  const seeded: string[] = [];
  const refreshed: string[] = [];
  if (!existsSync(bundledDir)) return { seeded, refreshed };
  const manifest = readManifest();
  let changed = false;
  for (const slug of readdirSync(bundledDir)) {
    const src = join(bundledDir, slug);
    if (isBuiltinSkillName(slug)) {
      console.warn(`[skills] bundled skill "${slug}" is named like a built-in skill, not seeding`);
      continue;
    }
    try {
      if (!statSync(src).isDirectory()) continue;
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const bundled = readFileSync(join(src, "SKILL.md"), "utf8");
      const want = sha(bundled);
      const dest = join(paths.skills, slug);
      const destMd = join(dest, "SKILL.md");
      const dirStat = lstatOrNull(dest);
      if (!dirStat) {
        cpSync(src, dest, { recursive: true });
        seeded.push(slug);
        manifest[slug] = want;
        changed = true;
        continue;
      }
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        console.warn(`[skills] ${dest} is ${dirStat.isSymbolicLink() ? "a symlink" : "not a directory"}: bundled skill "${slug}" not seeded or refreshed`);
        continue;
      }
      const mdStat = lstatOrNull(destMd);
      if (!mdStat) continue; // a directory without SKILL.md: someone else's, leave it
      if (mdStat.isSymbolicLink() || !mdStat.isFile()) {
        console.warn(`[skills] ${destMd} is ${mdStat.isSymbolicLink() ? "a symlink" : "not a plain file"}: bundled skill "${slug}" not refreshed`);
        continue;
      }
      const installed = readFileSync(destMd, "utf8");
      const have = sha(installed);
      if (have === want) {
        if (manifest[slug] !== want) (manifest[slug] = want), (changed = true);
        continue;
      }
      const releaseCopy = manifest[slug] !== undefined ? have === manifest[slug] : (prior[slug] ?? []).includes(have);
      if (!releaseCopy) {
        if (!reportedCustomised.has(slug)) {
          reportedCustomised.add(slug);
          const old = DEPRECATED_MEMORY_TOOLS.test(installed) ? "; it still names the old kb_* memory tools (aliases of memory_*)" : "";
          console.log(`[skills] bundled skill "${slug}" is customised here, left as is${old}`);
        }
        continue;
      }
      writeAtomic(destMd, bundled);
      refreshed.push(slug);
      manifest[slug] = want;
      changed = true;
    } catch (e) {
      console.warn(`[skills] failed to seed bundled skill "${slug}":`, e);
    }
  }
  if (changed) {
    try {
      mkdirSync(paths.skills, { recursive: true });
      writeAtomic(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (e) {
      console.warn("[skills] could not record the bundled skills seeded:", e);
    }
  }
  if (seeded.length > 0) console.log(`[skills] seeded bundled skills: ${seeded.join(", ")}`);
  if (refreshed.length > 0) console.log(`[skills] refreshed bundled skills to this release: ${refreshed.join(", ")}`);
  return { seeded, refreshed };
}

/** Test hook: report customised copies again. */
export function __resetSeedReports(): void {
  reportedCustomised.clear();
}
