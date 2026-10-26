import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeTemplateError } from "../soul/runtime/render";

/**
 * Render a background pass prompt from src/background/prompts/<name>.md. Only
 * `{{UPPER_SNAKE}}` is substituted, values inserted verbatim; a variable the
 * file names but `vars` lacks, or one passed but never used, throws (the same
 * contract as renderRuntimeFile for the soul's runtime files).
 */
export function renderPassPrompt(name: string, vars: Record<string, string>): string {
  const rel = `prompts/${name}.md`;
  const text = readFileSync(join(import.meta.dir, rel), "utf8");
  const used = new Set<string>();
  const out = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new RuntimeTemplateError(rel, k, "unknown");
    used.add(k);
    return vars[k]!;
  });
  for (const k of Object.keys(vars)) if (!used.has(k)) throw new RuntimeTemplateError(rel, k, "unused");
  return out.trimEnd();
}
