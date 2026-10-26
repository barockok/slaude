/**
 * Where a skill came from (spec §9.1 "Skill retirement scope"), which decides
 * whether the weekly skill review may retire it:
 *
 *   installed  its slug is in slaude.lock `skills` (the dependency installer
 *              or sync_manifest put it there; a sync would restore it);
 *   bundled    its slug is one the release bundles (seed.ts);
 *   agent      its frontmatter says `authored_by: agent` (stamped by
 *              write_skill itself, never by the model);
 *   installed  otherwise: an operator- or personas-repo-placed skill, or a
 *              lock that cannot be read. This fails safe.
 *
 * The lock and the bundled list win over the frontmatter, so a stamp on an
 * installed or bundled slug (write_skill editing it) never makes it the
 * agent's to retire. Built-in `slaude:*` skills are not in any skills root
 * and are never listed (invariant 9).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import type { Skill } from "./loader";
import { bundledSkillSlugs } from "./seed";

export type SkillProvenance = "agent" | "installed" | "bundled";

export interface ProvenanceSources {
  /** Slugs in slaude.lock `skills`; null when the lock exists but cannot be read. */
  locked: ReadonlySet<string> | null;
  bundled: ReadonlySet<string>;
}

/** slaude.lock's skill slugs: empty without a lock, null when it cannot be read. */
export function lockedSkillSlugs(lockPath: string = join(paths.home, "slaude.lock")): Set<string> | null {
  if (!existsSync(lockPath)) return new Set();
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { skills?: unknown };
    const skills = lock?.skills;
    if (skills === undefined) return new Set();
    if (skills === null || typeof skills !== "object" || Array.isArray(skills)) return null;
    return new Set(Object.keys(skills));
  } catch {
    return null;
  }
}

export function provenanceSources(): ProvenanceSources {
  return { locked: lockedSkillSlugs(), bundled: bundledSkillSlugs() };
}

export function skillProvenance(skill: Pick<Skill, "slug" | "authoredBy">, src: ProvenanceSources): SkillProvenance {
  if (src.locked === null || src.locked.has(skill.slug)) return "installed";
  if (src.bundled.has(skill.slug)) return "bundled";
  return skill.authoredBy === "agent" ? "agent" : "installed";
}
