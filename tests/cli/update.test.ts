// tests/cli/update.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapCurrent, pruneVersions, currentVersion, installedVersions } from "../../src/cli/dist";
import { runRollback } from "../../src/cli/update";

function seed(root: string, versions: string[], current?: string) {
  for (const v of versions) mkdirSync(join(root, v), { recursive: true });
  if (current) swapCurrent(root, current);
}

test("swapCurrent atomically repoints current", () => {
  const root = mkdtempSync(join(tmpdir(), "up-"));
  try {
    seed(root, ["0.1.0", "0.2.0"], "0.1.0");
    expect(currentVersion(root)).toBe("0.1.0");
    swapCurrent(root, "0.2.0");
    expect(currentVersion(root)).toBe("0.2.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneVersions keeps newest N + never removes current", () => {
  const root = mkdtempSync(join(tmpdir(), "up-"));
  try {
    seed(root, ["0.1.0", "0.2.0", "0.3.0", "0.4.0"], "0.1.0");
    const removed = pruneVersions(root, 2);
    // current (0.1.0) protected; keep newest 2 (0.3.0,0.4.0); remove 0.2.0 only.
    expect(removed).toEqual(["0.2.0"]);
    expect(existsSync(join(root, "0.1.0"))).toBe(true);
    expect(installedVersions(root)).toEqual(["0.1.0", "0.3.0", "0.4.0"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneVersions keeps the newest N total when current is newest", () => {
  const root = mkdtempSync(join(tmpdir(), "up-"));
  try {
    seed(root, ["0.1.0", "0.2.0", "0.3.0", "0.4.0"], "0.4.0");
    const removed = pruneVersions(root, 3);
    expect(removed).toEqual(["0.1.0"]);
    expect(installedVersions(root)).toEqual(["0.2.0", "0.3.0", "0.4.0"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runRollback flips to the previous version, errors when none", () => {
  const root = mkdtempSync(join(tmpdir(), "up-"));
  try {
    const out: string[] = [];
    seed(root, ["0.1.0", "0.2.0"], "0.2.0");
    expect(runRollback({ SLAUDE_DIST: root }, (s) => out.push(s))).toBe(0);
    expect(currentVersion(root)).toBe("0.1.0");

    // now only one version + current -> no previous
    rmSync(join(root, "0.2.0"), { recursive: true, force: true });
    expect(runRollback({ SLAUDE_DIST: root }, (s) => out.push(s))).toBe(1);
    expect(out.join("\n")).toContain("no previous version");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
