import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
 * What the seeder last wrote for each bundled slug: the sha256 of its SKILL.md.
 * A dot file in the skills root (the loader skips dot entries). A copy whose
 * SKILL.md still hashes to this was never edited, so a newer release may
 * replace it.
 */
const manifestPath = () => join(paths.skills, ".bundled.json");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function readManifest(): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(manifestPath(), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The memory tools' pre-rename names (still mounted as aliases). */
const DEPRECATED_MEMORY_TOOLS = /\bkb_(search|think|memoize)\b/;

/**
 * Whether an installed copy of a bundled skill is the release's own, safe to
 * replace with a newer bundled version:
 *  - its SKILL.md is what the seeder last wrote (the manifest hash); or
 *  - for a copy seeded before the manifest existed: it carries no
 *    write_skill stamp (`authored_by:`) and still teaches the memory tools'
 *    pre-rename names, so it predates the rename. The replaced text is kept
 *    beside it as SKILL.md.orig.
 */
function isReleaseCopy(installed: string, recorded: string | undefined): boolean {
  if (recorded !== undefined) return sha(installed) === recorded;
  return !/^authored_by:/m.test(installed) && DEPRECATED_MEMORY_TOOLS.test(installed);
}

/**
 * Copy any bundled skill that isn't already present into $SLAUDE_HOME/skills,
 * and bring an unedited copy up to the bundled version.
 *
 * An operator- or runtime-edited copy of the same slug is never clobbered, so
 * a deploy ships sane defaults while letting the live agent (and
 * `write_skill`) own the installed copy. A copy nobody edited (see
 * isReleaseCopy) is refreshed, so a release that changes a bundled skill
 * reaches deployments seeded by an older one. Best-effort: a failure here
 * must not block boot, so errors are logged and swallowed.
 */
export function seedBundledSkills(bundledDir: string = BUNDLED_SKILLS_DIR): { seeded: string[]; refreshed: string[] } {
  const seeded: string[] = [];
  const refreshed: string[] = [];
  if (!existsSync(bundledDir)) return { seeded, refreshed };
  const manifest = readManifest();
  let changed = false;
  for (const slug of readdirSync(bundledDir)) {
    const src = join(bundledDir, slug);
    if (isBuiltinSkillName(slug)) {
      console.warn(`[skills] bundled skill "${slug}" is named like a built-in skill — not seeding`);
      continue;
    }
    try {
      if (!statSync(src).isDirectory()) continue;
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const bundled = readFileSync(join(src, "SKILL.md"), "utf8");
      const dest = join(paths.skills, slug);
      const destMd = join(dest, "SKILL.md");
      if (existsSync(dest)) {
        const installed = existsSync(destMd) ? readFileSync(destMd, "utf8") : null;
        if (installed === bundled) {
          if (manifest[slug] !== sha(bundled)) (manifest[slug] = sha(bundled)), (changed = true);
          continue;
        }
        if (installed === null || !isReleaseCopy(installed, manifest[slug])) continue; // installed copy wins
        if (manifest[slug] === undefined) writeFileSync(join(dest, "SKILL.md.orig"), installed, "utf8");
        cpSync(src, dest, { recursive: true });
        refreshed.push(slug);
      } else {
        cpSync(src, dest, { recursive: true });
        seeded.push(slug);
      }
      manifest[slug] = sha(bundled);
      changed = true;
    } catch (e) {
      console.warn(`[skills] failed to seed bundled skill "${slug}":`, e);
    }
  }
  if (changed) {
    try {
      mkdirSync(paths.skills, { recursive: true });
      writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch (e) {
      console.warn("[skills] could not record the bundled skills seeded:", e);
    }
  }
  if (seeded.length > 0) console.log(`[skills] seeded bundled skills: ${seeded.join(", ")}`);
  if (refreshed.length > 0) console.log(`[skills] refreshed unedited bundled skills: ${refreshed.join(", ")}`);
  return { seeded, refreshed };
}
