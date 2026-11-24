/**
 * Full-source guards for memory places (spec section 2, "Adding a surface", guard 2):
 *  - only src/memory/place-id.ts (re-exported by place.ts) names or builds an `mb-` source id, in
 *    any string, template or regular expression literal; one reviewed recognition-only exception
 *    lives in the browser console, which cannot import node:crypto;
 *  - the new place code tests no platform id shape; the existing shape tests in memory code are a
 *    reviewed list, so an addition fails here.
 * Same idea as tests/access/no-string-authority.test.ts: scan all of src, not a file list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "../helpers/string-authority-scan";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require("typescript");

/** Files allowed to name the prefix. */
const PLACE_NAMING = new Set(["src/memory/place-id.ts"]);
/** Recognition only (a regex that tells a private store id in the browser). Constructing is never allowed here. */
const RECOGNITION_ONLY = new Set(["src/web/console/pages/memory/memoryParts.tsx"]);

const NAMES_PREFIX = /(^|[^a-z0-9])mb-/i;

/** Every string, template or regex literal text in a file, with its line. */
function literals(file: string, text: string): Array<{ line: number; text: string; kind: "string" | "template" | "regex" }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string; kind: "string" | "template" | "regex" }> = [];
  const K = ts.SyntaxKind;
  const visit = (n: any) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (n.kind === K.StringLiteral) out.push({ line, text: n.text, kind: "string" });
    else if (n.kind === K.NoSubstitutionTemplateLiteral || n.kind === K.TemplateHead || n.kind === K.TemplateMiddle || n.kind === K.TemplateTail) out.push({ line, text: n.text, kind: "template" });
    else if (n.kind === K.RegularExpressionLiteral) out.push({ line, text: n.text, kind: "regex" });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function placeNamingHits(file: string, text: string): string[] {
  if (PLACE_NAMING.has(file)) return [];
  return literals(file, text)
    .filter((l) => NAMES_PREFIX.test(l.text))
    .filter((l) => !(RECOGNITION_ONLY.has(file) && l.kind === "regex"))
    .map((l) => `${file}:${l.line} ${l.kind} literal names an mb- source id: ${l.text.slice(0, 60)}`);
}

describe("only place-id.ts names an mb- source id", () => {
  test("no other file in src builds, prefixes or matches one", () => {
    const hits = sourceFiles("src").flatMap((f) => placeNamingHits(f, readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("the scanner sees the places module and the whole tree", () => {
    const files = sourceFiles("src");
    expect(files).toContain("src/memory/place-id.ts");
    expect(files).toContain("src/memory/place.ts");
    expect(files.some((f) => f.startsWith("src/web/"))).toBe(true);
    expect(literals("src/memory/place-id.ts", readFileSync("src/memory/place-id.ts", "utf8")).some((l) => NAMES_PREFIX.test(l.text))).toBe(true);
  });

  describe("fails on a new construction", () => {
    const hit = (code: string, file = "src/example/new.ts") => placeNamingHits(file, code);
    test("a prefix test, a template, a concatenation, a regex", () => {
      expect(hit('const ok = s.startsWith("mb-");').length).toBe(1);
      expect(hit("const id = `mb-${hash}`;").length).toBe(1);
      expect(hit('const id = "mb-" + hash;').length).toBe(1);
      expect(hit("const re = /^mb-[0-9a-f]{28}$/;").length).toBe(1);
    });
    test("the naming file is the one place it is allowed; plain words and comments are not hits", () => {
      expect(hit('const x = "mb-" + h;', "src/memory/place-id.ts")).toEqual([]);
      expect(hit('// the mb- prefix\nconst x = "thumb-size";')).toEqual([]);
    });
    test("the console's recognition regex is allowed, a console string literal is not", () => {
      expect(hit("const r = /^(user-|mb-)/;", "src/web/console/pages/memory/memoryParts.tsx")).toEqual([]);
      expect(hit('const x = "mb-" + y;', "src/web/console/pages/memory/memoryParts.tsx").length).toBe(1);
    });
  });
});

describe("memory code tests no platform id shape for a place decision", () => {
  /** A regex or startsWith over what looks like a Slack id letter. */
  const SHAPE = /startsWith\(\s*["'][A-Z]["']\s*\)|\bCHANNEL_RE\b|\/\^?\[?[CGDUTW]\[?[A-Z0-9]/;
  /** Reviewed: memory code that already tested a shape before places (src/memory/scope.ts `isDmChannel`). */
  const REVIEWED: Record<string, string[]> = {
    "src/memory/scope.ts": ['export const isDmChannel = (channel: string | undefined): boolean => !!channel && channel.startsWith("D");'],
  };

  const shapeHits = (file: string, text: string): string[] =>
    text
      .split("\n")
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*") && SHAPE.test(l))
      .filter(({ l }) => !(REVIEWED[file] ?? []).includes(l))
      .map(({ l, n }) => `${file}:${n} ${l}`);

  test("nothing under src/memory tests a platform id shape beyond the reviewed line", () => {
    const hits = sourceFiles("src/memory").flatMap((f) => shapeHits(f, readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("the place modules never import the shape test from the resolver, only the surface-known answer", () => {
    for (const f of ["src/memory/place.ts", "src/memory/place-id.ts", "src/memory/place-shadow.ts", "src/memory/place-surface.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/\bCHANNEL_RE\b/);
    }
  });

  test("the scan catches a new shape test", () => {
    expect(shapeHits("src/memory/new.ts", 'if (channel.startsWith("C")) return x;').length).toBe(1);
    expect(shapeHits("src/memory/new.ts", "if (CHANNEL_RE.test(c)) return x;").length).toBe(1);
    expect(shapeHits("src/memory/new.ts", "const r = /^[CGD][A-Z0-9]+$/;").length).toBe(1);
    expect(shapeHits("src/memory/scope.ts", REVIEWED["src/memory/scope.ts"]![0]!)).toEqual([]);
  });
});
