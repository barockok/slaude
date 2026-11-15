// Static guard for the test-env leaks behind the 2026-11-16 CI flake (see the field note).
//
// Every test file runs in one bun process, and bun cannot run a preload hook per
// file, so a leak cannot be caught at run time by name. These two shapes caused
// real failures; this test fails naming the file that has one.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = import.meta.dir;
const files: string[] = [];
(function walk(d: string) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "panel-web") walk(p); }
    else if (/\.test\.ts$/.test(n) && p !== import.meta.path) files.push(p);
  }
})(ROOT);

const BRAIN_KEY = /^process\.env\.(SLAUDE_BRAIN_[A-Z_]+|SLAUDE_AGENT_ID|EMBEDDING_[A-Z_]+|GBRAIN_[A-Z_]+)\s*=/m;
const GATED = /realEnabled|describe\.skipIf|describe\.if|test\.skipIf|test\.if|SLAUDE_PG_TEST_URL|SLAUDE_BRAIN_PG_TEST_URL/;

test("no gated test file assigns a brain env var at its top level (a skipped file runs no afterAll, so it leaks)", () => {
  const bad = files.filter((f) => { const s = readFileSync(f, "utf8"); return GATED.test(s) && BRAIN_KEY.test(s); });
  expect(bad.map((f) => relative(ROOT, f))).toEqual([]);
});

test("a file that stubs the brain backend resets it", () => {
  const bad = files.filter((f) => {
    const s = readFileSync(f, "utf8");
    return /setBackendForTest\(\s*[^u)\s]/.test(s) && !/resetBackend\(\)|setBackendForTest\(\s*undefined/.test(s);
  });
  expect(bad.map((f) => relative(ROOT, f))).toEqual([]);
});
