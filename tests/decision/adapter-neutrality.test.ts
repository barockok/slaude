import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Engagement and the gate know no adapter by name. A different adapter is a
 * new file under src/decision/adapters plus one registration, so no file
 * outside the adapter's own module may import or name it.
 */
const SRC = join(import.meta.dir, "..", "..", "src");
const WORD = /\bjev\b/i;

/** file (relative to src) -> { lines that may match, why }. Add nothing here casually. */
const ALLOW: Record<string, { why: string; only?: RegExp }> = {
  "decision/adapters/jev.ts": { why: "the adapter itself" },
  "decision/adapters/index.ts": { why: "the one registration line", only: /^import "\.\/jev";$/ },
  "gateway/gate/questions.ts": {
    why: "a historical comment recording how the question wording was tuned; no code depends on it",
    only: /^\s*\/\/ Live Jev run:/,
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|md|css|html)$/.test(e)) out.push(p);
  }
  return out;
}

describe("adapter neutrality", () => {
  test("nothing outside the adapter module names it", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      const allow = ALLOW[rel];
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!WORD.test(line)) return;
          if (allow && (!allow.only || allow.only.test(line))) return;
          offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still matches something (the list cannot go stale)", () => {
    for (const rel of Object.keys(ALLOW)) {
      expect(readFileSync(join(SRC, rel), "utf8")).toMatch(WORD);
    }
  });
});
