/**
 * Slice F guard (as slice C task 18, for slices): every place in `src` that maps
 * a Slack id to a `user-` slice name, reads a slice name back as a person, or
 * resolves a Slack id to a credential account is a reviewed entry in
 * tests/slices/string-slice.allow.json with a reason, or the test fails. Also
 * every registered person-slice site is used by `src`, and the resolver is
 * reached only from the shadow seam.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SLICE_SITES } from "../../src/slices/sites";
import { SLICE_PATTERNS, checkSliceAllowlist, scanSliceText, scanSliceTree, type SliceAllow } from "../helpers/string-slice-scan";
import { sourceFiles } from "../helpers/string-authority-scan";

const allow = JSON.parse(readFileSync("tests/slices/string-slice.allow.json", "utf8")) as SliceAllow[];
const read = (f: string) => readFileSync(f, "utf8");

describe("no unreviewed slice-name or credential-account reader", () => {
  test("every hit in src is a reviewed allowlist entry", () => {
    expect(checkSliceAllowlist(scanSliceTree("src", read), allow)).toEqual([]);
  });

  test("every allowlist entry names a real file and a known pattern, with a reason", () => {
    for (const e of allow) {
      expect(() => readFileSync(e.file, "utf8")).not.toThrow();
      expect(Object.keys(SLICE_PATTERNS)).toContain(e.pattern);
      expect(e.reason.trim().length).toBeGreaterThan(20);
      expect(e.reason).not.toBe("MISSING");
      expect(e.lines.length).toBeGreaterThan(0);
    }
  });

  test("the credential and slice-name consumers the plan lists are on the list", () => {
    const files = new Set(allow.map((e) => e.file));
    for (const f of [
      "src/gateway/core/gateway.ts",
      "src/gateway/portal/onboarding-nudge.ts",
      "src/gateway/core/credential-import.ts",
      "src/gateway/core/mcp-cred-epoch.ts",
      "src/gateway/api/mcp-credentials.ts",
      "src/agent/mcp-oauth/persist.ts",
      "src/knowledge/mcp-tools.ts",
      "src/knowledge/gated-dispatch.ts",
      "src/db/thread-activity.ts",
      "src/background/pass-tools.ts",
      "src/background/passes/nightly-review.ts",
      "src/proactive/feedback.ts",
    ]) expect(files.has(f)).toBe(true);
  });

  test("the scanner covers all of src", () => {
    const files = sourceFiles("src");
    for (const dir of ["src/gateway/", "src/knowledge/", "src/memory/", "src/background/", "src/proactive/", "src/db/", "src/agent/"]) expect(files.some((f) => f.startsWith(dir))).toBe(true);
  });

  describe("fails on a new reader", () => {
    const sample = (code: string, extra: SliceAllow[] = []) => checkSliceAllowlist(scanSliceText("src/example/new.ts", code), extra);
    for (const code of [
      "const own = userSourceId(userId);",
      'if (s.startsWith("user-")) ok();',
      'const id = s.slice("user-".length);',
      "const a = await accountForSlackUser(team, id);",
      "const accounts = await accountIdsForSlackUserAnyTeam(id);",
      "const owners = await epochOwnersFor(owner);",
      "deps.accountFor ?? accountForSlackUser,",
    ]) {
      test(code, () => expect(sample(code).length).toBeGreaterThan(0));
    }
    test("imports and comments are not readers", () => {
      expect(sample('import { accountForSlackUser } from "../db/accounts";')).toEqual([]);
      expect(sample("// userSourceId(x) is the legacy slice")).toEqual([]);
    });
    test("a reviewed line passes, a swapped line is caught and the old one is stale", () => {
      const entry: SliceAllow = { file: "src/example/new.ts", pattern: "user-source-id", lines: ["const own = userSourceId(userId);"], reason: "a reviewed own slice by design" };
      expect(sample("const own = userSourceId(userId);", [entry])).toEqual([]);
      const swapped = sample("const other = userSourceId(someoneElse);", [entry]).join("\n");
      expect(swapped).toContain("unregistered");
      expect(swapped).toContain("stale allowlist line");
    });
  });
});

describe("the site registry", () => {
  test("every registered site is named by src code outside the registry", () => {
    const used = new Set<string>();
    for (const f of sourceFiles("src")) {
      if (f === "src/slices/sites.ts") continue;
      const text = read(f);
      for (const s of SLICE_SITES) if (text.includes(`"${s.id}"`)) used.add(s.id);
    }
    expect(SLICE_SITES.map((s) => s.id).filter((id) => !used.has(id))).toEqual([]);
  });

  test("decidePersonSlices is called only with a registered literal site id", () => {
    const ids = new Set<string>(SLICE_SITES.map((s) => s.id));
    const called: string[] = [];
    for (const f of sourceFiles("src")) {
      if (f === "src/slices/decide.ts") continue;
      for (const m of read(f).matchAll(/decidePersonSlices\(\{\s*site:\s*"([^"]+)"/g)) called.push(m[1]!);
      // Any other call shape (a variable site) would escape this check.
      const calls = (read(f).match(/decidePersonSlices\(/g) ?? []).length;
      const literal = (read(f).match(/decidePersonSlices\(\{\s*site:\s*"/g) ?? []).length;
      expect({ f, calls, literal }).toEqual({ f, calls, literal: calls });
    }
    expect(called.length).toBeGreaterThan(0);
    for (const id of called) expect(ids.has(id)).toBe(true);
  });

  test("the resolver is reached only from the seam, the tests' helpers excepted", () => {
    const importers = sourceFiles("src").filter((f) => /from\s+["'][^"']*person-slices["']/.test(read(f)));
    expect(importers).toEqual(["src/slices/decide.ts"]);
  });
});
