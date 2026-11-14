/**
 * Slice C task 18, the full-src guard. Every place in `src` that decides by
 * comparing Slack user id strings must either run through the access seam
 * (its line names a registered site id) or be a reviewed line in
 * tests/access/string-authority.allow.json with a reason. A new compare that
 * is neither fails here, so a site cannot be left on strings by accident
 * before the access flip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SITES } from "../../src/access/sites";
import { PATTERNS, checkAgainstAllowlist, isRegistered, scanText, scanTree, sourceFiles, type AllowEntry } from "../helpers/string-authority-scan";

const allow = JSON.parse(readFileSync("tests/access/string-authority.allow.json", "utf8")) as AllowEntry[];

describe("no string authority outside the seam", () => {
  test("every compare in src is a registered site or a reviewed allowlist entry", () => {
    expect(checkAgainstAllowlist(scanTree("src"), allow)).toEqual([]);
  });

  test("every allowlist entry names a real file and a known pattern, with a reason", () => {
    for (const e of allow) {
      expect(() => readFileSync(e.file, "utf8")).not.toThrow();
      expect(Object.keys(PATTERNS)).toContain(e.pattern);
      expect(e.reason.trim().length).toBeGreaterThan(10);
      expect(e.count).toBeGreaterThan(0);
    }
  });

  test("the scanner covers all of src, not a file list", () => {
    const files = sourceFiles("src");
    for (const dir of ["src/gateway/", "src/knowledge/", "src/memory/", "src/background/", "src/soul/", "src/remote/", "src/proactive/", "src/db/", "src/persona/", "src/agent/", "src/web/"]) {
      expect(files.some((f) => f.startsWith(dir))).toBe(true);
    }
  });

  describe("fails on a new unregistered compare", () => {
    const sample = (code: string, extra: AllowEntry[] = []) => checkAgainstAllowlist(scanText("src/example/new-site.ts", code), extra);

    for (const code of [
      "if (userId !== managerId) return;",
      "if (lock.locked_user === userId) ok();",
      "if (ctx.userId === soul.manager.userId) ok();",
      "if (managers.includes(by)) ok();",
      "if (!approvers.has(userId)) return;",
      "const blocked = soul.blockedUsers.includes(u);",
      "if (clicker !== initiator) return;",
      "return row.toUser === by;",
    ]) {
      test(code, () => {
        expect(sample(code).length).toBeGreaterThan(0);
      });
    }

    test("the same compare through a registered site passes", () => {
      expect(sample('if (!sameAt({ site: "gateway.admit", userId, otherUserId: lock.locked_user })) return;')).toEqual([]);
      expect(sample('if (!(await managerAt("gateway.cron.role", p, userId, t))) return;')).toEqual([]);
    });

    test("an unknown site id does not exempt a compare", () => {
      expect(sample('if (!sameAt({ site: "no.such.site", userId, otherUserId: lock.locked_user })) return;').length).toBeGreaterThan(0);
    });

    test("a compare added to an already allowlisted file is caught by the count", () => {
      const entry: AllowEntry = { file: "src/example/new-site.ts", pattern: "locked_user", count: 1, reason: "a reviewed display line" };
      expect(sample("log(lock.locked_user);", [entry])).toEqual([]);
      expect(sample("log(lock.locked_user);\nif (lock.locked_user === userId) ok();", [entry]).length).toBeGreaterThan(0);
    });

    test("an allowlist entry that no longer matches anything is reported", () => {
      const entry: AllowEntry = { file: "src/example/new-site.ts", pattern: "locked_user", count: 1, reason: "a reviewed display line" };
      expect(sample("const x = 1;", [entry]).join(" ")).toContain("stale allowlist entry");
    });

    test("comments, null checks and string literals are not compares", () => {
      expect(scanText("src/x.ts", "// userId !== managerId").length).toBe(0);
      expect(scanText("src/x.ts", " * lock.locked_user === userId in a comment block").length).toBe(0);
      expect(scanText("src/x.ts", 'if (typeof clicker !== "string") return;').length).toBe(0);
      expect(scanText("src/x.ts", "if (slackUserId === undefined) return;").length).toBe(0);
    });
  });

  test("the registry's site ids are all used by src code", () => {
    const used = new Set<string>();
    for (const f of sourceFiles("src")) {
      const text = readFileSync(f, "utf8");
      for (const s of SITES) if (f !== "src/access/sites.ts" && text.includes(`"${s.id}"`)) used.add(s.id);
    }
    expect(SITES.map((s) => s.id).filter((id) => !used.has(id))).toEqual([]);
  });

  test("isRegistered only trusts known ids", () => {
    expect(isRegistered('x({ site: "gateway.admit" })')).toBe(true);
    expect(isRegistered('x({ site: "gateway.nope" })')).toBe(false);
  });
});
