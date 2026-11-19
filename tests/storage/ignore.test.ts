import { describe, expect, test } from "bun:test";
import { DEFAULT_IGNORE, ignoreList, isIgnored } from "../../src/storage/ignore";

describe("sync ignore list", () => {
  test("the default list skips a virtualenv but keeps .git", () => {
    expect(DEFAULT_IGNORE).toContain(".venv");
    expect(DEFAULT_IGNORE).not.toContain(".git");
    expect(isIgnored("project/.venv/bin/python", ignoreList({}))).toBe(true);
    expect(isIgnored("project/.git/HEAD", ignoreList({}))).toBe(false);
  });

  test("SLAUDE_SYNC_IGNORE replaces the default list entirely", () => {
    const names = ignoreList({ SLAUDE_SYNC_IGNORE: "build, tmp" });
    expect(names).toEqual(["build", "tmp"]);
    expect(isIgnored("a/.venv/x", names)).toBe(false);
    expect(isIgnored("a/build/x", names)).toBe(true);
  });
});
