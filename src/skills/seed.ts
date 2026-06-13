import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";

/**
 * Bundled skills ship in the repo under `<repoRoot>/skills/<slug>/SKILL.md` and
 * are seeded into `$SLAUDE_HOME/skills/` on boot. `src/skills/seed.ts` →
 * repo root is two levels up (`../../`), so the bundled dir is `../../skills`.
 */
const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");

/**
 * Copy any bundled skill that isn't already present into $SLAUDE_HOME/skills.
 *
 * Seed-if-missing only: an operator- or runtime-edited copy of the same slug is
 * never clobbered, so a deploy ships sane defaults while letting the live agent
 * (and `write_skill`) own the installed copy. Best-effort — a failure here must
 * not block boot, so errors are logged and swallowed.
 */
export function seedBundledSkills(): { seeded: string[] } {
  const seeded: string[] = [];
  if (!existsSync(BUNDLED_SKILLS_DIR)) return { seeded };
  for (const slug of readdirSync(BUNDLED_SKILLS_DIR)) {
    const src = join(BUNDLED_SKILLS_DIR, slug);
    try {
      if (!statSync(src).isDirectory()) continue;
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const dest = join(paths.skills, slug);
      if (existsSync(dest)) continue; // installed copy wins
      cpSync(src, dest, { recursive: true });
      seeded.push(slug);
    } catch (e) {
      console.warn(`[skills] failed to seed bundled skill "${slug}":`, e);
    }
  }
  if (seeded.length > 0) {
    console.log(`[skills] seeded bundled skills: ${seeded.join(", ")}`);
  }
  return { seeded };
}
