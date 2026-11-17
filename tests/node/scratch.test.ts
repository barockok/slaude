import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { ChildEnvPatch, scrubChildEnv } from "../../src/agent/child-env";
import { ScratchDirs, withScratchEnv } from "../../src/node/scratch";

const made: ScratchDirs[] = [];
const mk = () => { const s = new ScratchDirs(); made.push(s); return s; };
afterEach(() => { for (const s of made.splice(0)) s.removeAll(); });

describe("per-session scratch directories", () => {
  test("a session's directory is created private (0700) under one 0700 root in the temp area", () => {
    const s = mk();
    const dir = s.ensure("sess-1");
    expect(dir.startsWith(tmpdir().replace(/\/+$/, "") + sep) || dir.startsWith(require("node:fs").realpathSync(tmpdir()) + sep)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
    expect(s.ensure("sess-1")).toBe(dir);
  });

  test("two sessions get two separate directories", () => {
    const s = mk();
    expect(s.ensure("a")).not.toBe(s.ensure("b"));
  });

  test("pathFor names only an existing directory", () => {
    const s = mk();
    expect(s.pathFor("sess-2")).toBeUndefined();
    const dir = s.ensure("sess-2");
    expect(s.pathFor("sess-2")).toBe(dir);
    s.remove("sess-2");
    expect(s.pathFor("sess-2")).toBeUndefined();
  });

  test("remove deletes the directory and what is in it; removeAll deletes the root", () => {
    const s = mk();
    const a = s.ensure("a");
    writeFileSync(join(a, "f.txt"), "x");
    const b = s.ensure("b");
    s.remove("a");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    s.removeAll();
    expect(existsSync(b)).toBe(false);
    expect(existsSync(join(b, ".."))).toBe(false);
  });

  test("a session id that is a path never escapes the root", () => {
    const s = mk();
    const root = dirname(s.ensure("plain"));
    for (const id of ["../x", "a/b", "..", "", "a\u0000b"]) {
      const dir = s.ensure(id);
      expect(dirname(dir)).toBe(root);
      expect(s.pathFor(id)).toBe(dir);
    }
    expect(s.ensure("../x")).not.toBe(s.ensure("x"));
  });
});

describe("withScratchEnv", () => {
  test("adds TMPDIR and SLAUDE_SCRATCH to a plain overlay, an absent overlay and a patch", async () => {
    const s = mk();
    const dir = s.ensure("sess-3");
    const want = { TMPDIR: dir, SLAUDE_SCRATCH: dir };
    expect(await withScratchEnv(async () => ({ A: "1" }), s)("sess-3")).toEqual({ A: "1", ...want });
    expect(await withScratchEnv(async () => undefined, s)("sess-3")).toEqual(want);
    const patched = await withScratchEnv(async () => new ChildEnvPatch({ A: "1" }, ["B"]), s)("sess-3");
    expect(patched).toBeInstanceOf(ChildEnvPatch);
    expect((patched as ChildEnvPatch).set).toEqual({ A: "1", ...want });
    expect((patched as ChildEnvPatch).unset).toEqual(["B"]);
  });

  test("creates the directory when the child boots", async () => {
    const s = mk();
    await withScratchEnv(async () => undefined, s)("fresh");
    expect(s.pathFor("fresh")).toBeDefined();
  });

  test("the added names survive the child-env scrub and add no secret", async () => {
    const s = mk();
    const env: any = await withScratchEnv(async () => undefined, s)("sess-4");
    expect(Object.keys(scrubChildEnv(env)).sort()).toEqual(["SLAUDE_SCRATCH", "TMPDIR"]);
  });
});
