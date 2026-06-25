// tests/cli/dist.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distPaths, installedVersions, currentVersion, previousVersion } from "../../src/cli/dist";

test("distPaths derives root/current/binLink from env + HOME", () => {
  const p = distPaths({ HOME: "/home/x" });
  expect(p.root).toBe("/home/x/.slaude-dist");
  expect(p.current).toBe("/home/x/.slaude-dist/current");
  expect(p.binLink).toBe("/home/x/.local/bin/slaude");

  const o = distPaths({ HOME: "/h", SLAUDE_DIST: "/d", SLAUDE_BIN_DIR: "/b" });
  expect(o.root).toBe("/d");
  expect(o.binLink).toBe("/b/slaude");
});

test("installedVersions lists + semver-sorts version dirs, ignoring junk", () => {
  const root = mkdtempSync(join(tmpdir(), "dist-"));
  try {
    for (const v of ["0.9.0", "0.10.0", "0.10.2"]) mkdirSync(join(root, v));
    mkdirSync(join(root, "not-a-version"));
    symlinkSync("0.10.2", join(root, "current"));
    expect(installedVersions(root)).toEqual(["0.9.0", "0.10.0", "0.10.2"]);
    expect(currentVersion(root)).toBe("0.10.2");
    expect(previousVersion(root)).toBe("0.10.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
