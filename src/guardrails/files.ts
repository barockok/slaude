/**
 * GUARDRAIL.md files on disk: authoring input only. `slaude guardrails import`
 * and `personas render` read a folder of `<slug>/GUARDRAIL.md`; the runtime
 * never does (the database is the only runtime source, design section 2).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GUARDRAIL_SLUG_RE, MAX_GUARDRAIL_BYTES, RESERVED_SLUGS } from "./format";

/** Most guardrails one folder may hold. */
export const MAX_GUARDRAILS = 200;

export class GuardrailFilesError extends Error {}

/** Validate a slug the way every writer does. */
export function checkSlug(slug: string): void {
  if (!GUARDRAIL_SLUG_RE.test(slug)) throw new GuardrailFilesError(`'${slug.slice(0, 64)}' is not a guardrail name (${GUARDRAIL_SLUG_RE.source})`);
  if (RESERVED_SLUGS.has(slug)) throw new GuardrailFilesError(`'${slug}' is reserved; choose another guardrail name`);
}

/**
 * Every `<slug>/GUARDRAIL.md` under `dir`, sorted by slug. A folder without a
 * GUARDRAIL.md is skipped; a bad name, an oversized file or too many folders
 * fail the whole read (nothing half-imported).
 */
export function readGuardrailDir(dir: string): Array<{ slug: string; md: string }> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new GuardrailFilesError(`no guardrails folder at ${dir}`);
  const out: Array<{ slug: string; md: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    const file = join(sub, "GUARDRAIL.md");
    if (!existsSync(file)) continue;
    checkSlug(name);
    const size = statSync(file).size;
    if (size > MAX_GUARDRAIL_BYTES) throw new GuardrailFilesError(`guardrail '${name}': GUARDRAIL.md is ${size} bytes; at most ${MAX_GUARDRAIL_BYTES}`);
    out.push({ slug: name, md: readFileSync(file, "utf8") });
  }
  if (out.length > MAX_GUARDRAILS) throw new GuardrailFilesError(`${out.length} guardrails; at most ${MAX_GUARDRAILS}`);
  return out;
}
