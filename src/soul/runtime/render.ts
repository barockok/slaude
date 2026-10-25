import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A runtime prompt file and the variables passed to render it disagree. */
export class RuntimeTemplateError extends Error {
  constructor(file: string, variable: string, why: "unknown" | "unused") {
    super(
      why === "unknown"
        ? `runtime file ${file}: variable {{${variable}}} has no value`
        : `runtime file ${file}: variable ${variable} was passed but never used`,
    );
    this.name = "RuntimeTemplateError";
  }
}

/**
 * Render a read-only prompt file under src/soul/runtime/ (path relative to that
 * directory). Only `{{UPPER_SNAKE}}` is substituted; `${...}` text stays literal.
 * Replacement values are inserted verbatim (never re-scanned).
 */
export function renderRuntimeFile(rel: string, vars: Record<string, string>): string {
  const text = readFileSync(join(import.meta.dir, rel), "utf8");
  const used = new Set<string>();
  const out = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new RuntimeTemplateError(rel, k, "unknown");
    used.add(k);
    return vars[k]!;
  });
  for (const k of Object.keys(vars)) if (!used.has(k)) throw new RuntimeTemplateError(rel, k, "unused");
  return out;
}
