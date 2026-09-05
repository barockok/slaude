import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitTracked } from "../../src/config/git-track";

function hasGit(): boolean {
  try {
    execSync("git --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("ensureGitTracked", () => {
  test("git-inits a plain directory and commits its content", () => {
    if (!hasGit()) return;
    const dir = mkdtempSync(join(tmpdir(), "slaude-gittrack-"));
    try {
      writeFileSync(join(dir, "README.md"), "# fixture\n");
      ensureGitTracked(dir);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      const tracked = execSync("git ls-tree -r HEAD --name-only", { cwd: dir, encoding: "utf8" }).trim();
      expect(tracked.split("\n")).toContain("README.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — a second call with no changes makes no new commit", () => {
    if (!hasGit()) return;
    const dir = mkdtempSync(join(tmpdir(), "slaude-gittrack-"));
    try {
      writeFileSync(join(dir, "README.md"), "# fixture\n");
      ensureGitTracked(dir);
      const first = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      ensureGitTracked(dir);
      const second = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("picks up and commits content changed after the first call", () => {
    if (!hasGit()) return;
    const dir = mkdtempSync(join(tmpdir(), "slaude-gittrack-"));
    try {
      writeFileSync(join(dir, "README.md"), "# fixture\n");
      ensureGitTracked(dir);
      const first = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      mkdirSync(join(dir, "wiki"), { recursive: true });
      writeFileSync(join(dir, "wiki", "page.md"), "# page\n");
      ensureGitTracked(dir);
      const second = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      expect(second).not.toBe(first);
      const tracked = execSync("git ls-tree -r HEAD --name-only", { cwd: dir, encoding: "utf8" }).trim();
      expect(tracked.split("\n")).toContain("wiki/page.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("heals a directory that already exists but predates git-tracking", () => {
    if (!hasGit()) return;
    // Simulates an install.ts-managed KB dir from before this fix shipped:
    // content on disk, no .git.
    const dir = mkdtempSync(join(tmpdir(), "slaude-gittrack-"));
    try {
      mkdirSync(join(dir, "wiki"), { recursive: true });
      writeFileSync(join(dir, "README.md"), "# pre-existing\n");
      writeFileSync(join(dir, "wiki", "page.md"), "# page\n");
      expect(existsSync(join(dir, ".git"))).toBe(false);
      ensureGitTracked(dir);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      const tracked = execSync("git ls-tree -r HEAD --name-only", { cwd: dir, encoding: "utf8" }).trim();
      expect(tracked.split("\n").sort()).toEqual(["README.md", "wiki/page.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
