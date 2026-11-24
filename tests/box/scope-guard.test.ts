/**
 * Scope guard (box plan, Global Constraints): boxes and remote environments
 * are separate features. Nothing under src/box/ imports src/remote/, and
 * nothing under src/remote/ imports src/box/.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every module specifier a file names: static, side-effect, dynamic, require, re-export. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const res = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** The files under `fromDir` that import something under `toDir`. */
function crossings(fromDir: string, toDir: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(fromDir)) {
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (target === toDir || target.startsWith(toDir + sep)) hits.push(`${relative(ROOT, file)} -> ${spec}`);
    }
  }
  return hits;
}

describe("box and remote environments stay apart", () => {
  const box = join(SRC, "box");
  const remote = join(SRC, "remote");

  it("the guard reads real files", () => {
    expect(sourceFiles(box).length).toBeGreaterThan(0);
    expect(sourceFiles(remote).length).toBeGreaterThan(0);
  });

  it("no file under src/box/ imports src/remote/", () => {
    expect(crossings(box, remote)).toEqual([]);
  });

  it("no file under src/remote/ imports src/box/", () => {
    expect(crossings(remote, box)).toEqual([]);
  });

  it("the matcher catches each import form", () => {
    const sample = [
      `import { a } from "../remote/x";`,
      `import "../remote/side";`,
      `const m = await import("../remote/dyn");`,
      `const r = require("../remote/req");`,
      `export * from "../remote/re";`,
    ].join("\n");
    expect(specifiers(sample).sort()).toEqual(["../remote/dyn", "../remote/re", "../remote/req", "../remote/side", "../remote/x"].sort());
  });
});
