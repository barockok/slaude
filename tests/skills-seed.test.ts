import { afterAll, afterEach, describe, expect, spyOn, test, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/home";
import { PRIOR_BUNDLED_VERSIONS, __resetSeedReports, seedBundledSkills } from "../src/skills/seed";

// Every test file shares one $SLAUDE_HOME (tests/setup.ts): leave no bundled
// skill behind, or a later file sees it as an installed global skill.
afterAll(() => {
  for (const slug of ["how-slaude-works", "ordinary-one"]) rmSync(join(paths.skills, slug), { recursive: true, force: true });
  rmSync(join(paths.skills, ".bundled.json"), { force: true });
});

const fakes: string[] = [];
beforeEach(() => {
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  __resetSeedReports();
});
afterEach(() => {
  for (const d of fakes.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  fakes.push(d);
  return d;
};
/** A bundled dir with one skill `ordinary-one` whose SKILL.md is `text`. */
const bundle = (text: string) => {
  const d = tmp("seed-fake-");
  mkdirSync(join(d, "ordinary-one"), { recursive: true });
  writeFileSync(join(d, "ordinary-one", "SKILL.md"), text, "utf8");
  return d;
};
const installed = () => join(paths.skills, "ordinary-one", "SKILL.md");
const install = (text: string) => {
  mkdirSync(join(paths.skills, "ordinary-one"), { recursive: true });
  writeFileSync(installed(), text, "utf8");
};

describe("seedBundledSkills", () => {
  test("seeds the bundled how-slaude-works skill into an empty home", () => {
    const { seeded } = seedBundledSkills();
    expect(seeded).toContain("how-slaude-works");
    const md = join(paths.skills, "how-slaude-works", "SKILL.md");
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, "utf8")).toContain("How slaude works");
  });

  test("is idempotent and never clobbers an installed copy", () => {
    seedBundledSkills();
    // Operator/runtime edits the installed copy.
    const md = join(paths.skills, "how-slaude-works", "SKILL.md");
    writeFileSync(md, "EDITED", "utf8");

    const { seeded } = seedBundledSkills();
    expect(seeded).not.toContain("how-slaude-works");
    expect(readFileSync(md, "utf8")).toBe("EDITED");
  });

  test("the shipped how-slaude-works teaches the memory_* tool names", () => {
    const md = readFileSync(join(import.meta.dir, "..", "skills", "how-slaude-works", "SKILL.md"), "utf8");
    expect(md).toContain("memory_search");
    expect(md).toContain("memory_think");
    expect(md).toContain("memory_save");
    expect(md).not.toMatch(/\bkb_(search|think|memoize)\b/);
  });

  test("an unedited copy from an older release is refreshed to the bundled version", () => {
    const fake = mkdtempSync(join(tmpdir(), "seed-fake-"));
    mkdirSync(join(fake, "ordinary-one"), { recursive: true });
    writeFileSync(join(fake, "ordinary-one", "SKILL.md"), "v1", "utf8");
    expect(seedBundledSkills(fake).seeded).toEqual(["ordinary-one"]);
    const md = join(paths.skills, "ordinary-one", "SKILL.md");

    // The next release changes it; the installed copy is still what was seeded.
    writeFileSync(join(fake, "ordinary-one", "SKILL.md"), "v2", "utf8");
    expect(seedBundledSkills(fake)).toEqual({ seeded: [], refreshed: ["ordinary-one"] });
    expect(readFileSync(md, "utf8")).toBe("v2");

    // Edited after seeding: the edit wins over v3.
    writeFileSync(md, "v2, edited", "utf8");
    writeFileSync(join(fake, "ordinary-one", "SKILL.md"), "v3", "utf8");
    expect(seedBundledSkills(fake).refreshed).toEqual([]);
    expect(readFileSync(md, "utf8")).toBe("v2, edited");
    rmSync(fake, { recursive: true, force: true });
  });

  test("a copy from before the manifest is refreshed only when it is exactly a prior shipped version", () => {
    const v1 = "---\nname: ordinary-one\n---\nCheck `kb_search` first.\n";
    const fake = bundle("v2");
    install(v1);
    expect(seedBundledSkills(fake, { priorVersions: { "ordinary-one": [sha(v1)] } })).toEqual({ seeded: [], refreshed: ["ordinary-one"] });
    expect(readFileSync(installed(), "utf8")).toBe("v2");
    // No backup: the replaced text was a known release copy.
    expect(readdirSync(join(paths.skills, "ordinary-one"))).toEqual(["SKILL.md"]);
    expect(JSON.parse(readFileSync(join(paths.skills, ".bundled.json"), "utf8"))).toEqual({ "ordinary-one": sha("v2") });
  });

  test("a second run is a no-op", () => {
    const fake = bundle("v2");
    install("v1");
    const opts = { priorVersions: { "ordinary-one": [sha("v1")] } };
    expect(seedBundledSkills(fake, opts).refreshed).toEqual(["ordinary-one"]);
    const manifest = readFileSync(join(paths.skills, ".bundled.json"), "utf8");
    expect(seedBundledSkills(fake, opts)).toEqual({ seeded: [], refreshed: [] });
    expect(readFileSync(installed(), "utf8")).toBe("v2");
    expect(readFileSync(join(paths.skills, ".bundled.json"), "utf8")).toBe(manifest);
  });

  test("an unstamped hand edit that still names kb_* is kept, and reported once as customised", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const edited = "---\nname: ordinary-one\n---\nOur own notes: use `kb_search` and `kb_memoize`.\n";
      const fake = bundle("v2");
      install(edited);
      const opts = { priorVersions: { "ordinary-one": [sha("v1")] } };
      expect(seedBundledSkills(fake, opts).refreshed).toEqual([]);
      expect(seedBundledSkills(fake, opts).refreshed).toEqual([]);
      expect(readFileSync(installed(), "utf8")).toBe(edited);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("customised"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("kb_*");
    } finally {
      log.mockRestore();
    }
  });

  test("a symlinked skill directory or SKILL.md is never written through", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outside = tmp("seed-outside-");
      writeFileSync(join(outside, "SKILL.md"), "v1", "utf8");
      const fake = bundle("v2");
      const opts = { priorVersions: { "ordinary-one": [sha("v1")] } };

      symlinkSync(outside, join(paths.skills, "ordinary-one"));
      expect(seedBundledSkills(fake, opts)).toEqual({ seeded: [], refreshed: [] });
      expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("v1");
      rmSync(join(paths.skills, "ordinary-one"));

      mkdirSync(join(paths.skills, "ordinary-one"));
      symlinkSync(join(outside, "SKILL.md"), installed());
      expect(seedBundledSkills(fake, opts)).toEqual({ seeded: [], refreshed: [] });
      expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("v1");
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("symlink"))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a corrupt or malformed manifest warns, keeps only well-formed entries, and never refreshes an edit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = bundle("v2");
      const opts = { priorVersions: { "ordinary-one": [sha("v1")] } };
      install("an operator's edit");
      writeFileSync(join(paths.skills, ".bundled.json"), "{not json", "utf8");
      expect(seedBundledSkills(fake, opts).refreshed).toEqual([]);
      expect(readFileSync(installed(), "utf8")).toBe("an operator's edit");
      expect(warn.mock.calls.some((c) => String(c[0]).includes(".bundled.json"))).toBe(true);

      // A non-hash entry is dropped (not trusted as "what was seeded"): the known prior version still decides.
      writeFileSync(join(paths.skills, ".bundled.json"), JSON.stringify({ "ordinary-one": "not-a-hash", other: 3 }), "utf8");
      install("v1");
      expect(seedBundledSkills(fake, opts).refreshed).toEqual(["ordinary-one"]);
      expect(JSON.parse(readFileSync(join(paths.skills, ".bundled.json"), "utf8"))).toEqual({ "ordinary-one": sha("v2") });
    } finally {
      warn.mockRestore();
    }
  });

  test("the known prior versions are 64-hex hashes, none of them the current bundled version", () => {
    const current = sha(readFileSync(join(import.meta.dir, "..", "skills", "how-slaude-works", "SKILL.md"), "utf8"));
    for (const [, hashes] of Object.entries(PRIOR_BUNDLED_VERSIONS)) {
      for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes).not.toContain(current);
    }
  });

  test("with git history present, the prior hashes are exactly the earlier shipped how-slaude-works versions", () => {
    const repo = join(import.meta.dir, "..");
    const revs = spawnSync("git", ["rev-list", "HEAD", "--", "skills/how-slaude-works/SKILL.md"], { cwd: repo, encoding: "utf8" });
    if (revs.status !== 0 || !revs.stdout.trim()) return; // shallow or no git: nothing to compare
    const current = sha(readFileSync(join(repo, "skills", "how-slaude-works", "SKILL.md"), "utf8"));
    const shipped = new Set<string>();
    for (const rev of revs.stdout.trim().split("\n")) {
      const blob = spawnSync("git", ["cat-file", "blob", `${rev}:skills/how-slaude-works/SKILL.md`], { cwd: repo, encoding: "utf8" });
      if (blob.status === 0) shipped.add(sha(blob.stdout));
    }
    shipped.delete(current);
    // A shallow clone may hold fewer versions; every one it holds must be listed.
    for (const h of shipped) expect(PRIOR_BUNDLED_VERSIONS["how-slaude-works"]).toContain(h);
  });

  test("skips a bundled skill named like a built-in, seeds the rest", () => {
    const fake = mkdtempSync(join(tmpdir(), "seed-fake-"));
    for (const slug of ["skill-authoring", "ordinary-one"]) {
      mkdirSync(join(fake, slug), { recursive: true });
      writeFileSync(join(fake, slug, "SKILL.md"), "x", "utf8");
    }
    const { seeded } = seedBundledSkills(fake);
    rmSync(fake, { recursive: true, force: true });
    expect(seeded).toEqual(["ordinary-one"]);
    expect(existsSync(join(paths.skills, "skill-authoring"))).toBe(false);
  });
});
