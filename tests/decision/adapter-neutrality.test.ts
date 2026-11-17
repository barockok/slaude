import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Engagement and the gate know no adapter by name. A different adapter is a
 * new file under src/decision/adapters plus one registration, so no file
 * outside the adapter's own module may import or name it.
 */
const SRC = join(import.meta.dir, "..", "..", "src");
/** A case-insensitive substring, so `jevClient` or `JEV_URL` is caught as well as the bare name. */
const NAMED = /jev/i;
export const namesAdapter = (line: string): boolean => NAMED.test(line);

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
    else out.push(p);
  }
  return out;
}

describe("adapter neutrality", () => {
  test("nothing outside the adapter module names it", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      const allow = ALLOW[rel];
      const buf = readFileSync(f);
      if (buf.includes(0)) continue; // a binary file (an image) holds no source text
      buf
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!namesAdapter(line)) return;
          if (allow && (!allow.only || allow.only.test(line))) return;
          offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the matcher catches substrings, any case, and ignores clean lines", () => {
    for (const line of ["const jevClient = 1", "JEV_URL=x", "// see Jev docs", "import x from './myJevAdapter'", "xJEVx"]) expect(namesAdapter(line)).toBe(true);
    for (const line of ["const adapter = pick()", "// a decision adapter", "jeVv".slice(0, 2)]) expect(namesAdapter(line)).toBe(false);
  });

  test("every allowlist entry still matches something (the list cannot go stale)", () => {
    for (const rel of Object.keys(ALLOW)) {
      expect(readFileSync(join(SRC, rel), "utf8")).toMatch(NAMED);
    }
  });
});
