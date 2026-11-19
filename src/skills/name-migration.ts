import { existsSync, readdirSync } from "node:fs";
import { paths } from "../config/home";
import { SKILL_SLUG_RE, discoverSkills } from "./loader";
import { skillOps } from "./mcp-tools";
import { provenanceSources, skillProvenance, type ProvenanceSources } from "./provenance";

const GLOBAL_SCOPE = "global";

/**
 * One-time, idempotent migration for skills written before write_skill named a skill by its slug.
 *
 * The CLI matches a skill by its frontmatter `name`, so an agent-written skill whose `name` is a human title
 * ("Clone a repo by name") cannot be called by its slug. This rewrites each such skill through the normal write
 * path (version log, announcement, object-store push) so its `name` is the slug and the old name is kept as
 * `title`; body, description and authored_at are preserved. Only skills with agent provenance are touched:
 * installed, bundled and operator-placed skills stay as their owners wrote them. A skill the write refuses is
 * logged and skipped; the rest still migrate. Returns `<scope>/<slug>` for each skill rewritten.
 */
export function normaliseSkillNames(opts: { sources?: ProvenanceSources; personas?: string[] } = {}): string[] {
  const src = opts.sources ?? provenanceSources();
  const personas = opts.personas ?? (existsSync(paths.personas) ? readdirSync(paths.personas) : []);
  const scopes: Array<{ scope: string; persona?: string }> = [{ scope: GLOBAL_SCOPE }];
  for (const p of personas) if (!p.startsWith(".") && p !== GLOBAL_SCOPE) scopes.push({ scope: p, persona: p });

  const done: string[] = [];
  for (const { scope, persona } of scopes) {
    for (const skill of discoverSkills(persona)) {
      // discoverSkills merges the base into a persona's list: only the persona's own overlay belongs to its scope.
      if (persona && skill.source !== "persona") continue;
      if (skillProvenance(skill, src) !== "agent" || !SKILL_SLUG_RE.test(skill.slug)) continue;
      if (skill.name === skill.slug) continue; // already callable by slug (a missing name defaults to the slug)
      try {
        const at = skill.authoredAt ? new Date(skill.authoredAt) : undefined;
        skillOps.write(skill.slug, skill.title ?? skill.name, skill.description, skill.body, persona, at && !Number.isNaN(at.getTime()) ? at : undefined);
        done.push(`${scope}/${skill.slug}`);
      } catch (e) {
        console.error(`[skills] could not rename ${scope}/${skill.slug} to its slug: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (done.length) console.log(`[skills] named ${done.length} agent-written skill(s) by their slug: ${done.join(", ")}`);
  return done;
}
