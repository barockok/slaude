import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../src/config/home";
import { seedBundledSkills } from "../src/skills/seed";

// Every test file shares one $SLAUDE_HOME (tests/setup.ts): leave no bundled
// skill behind, or a later file sees it as an installed global skill.
afterAll(() => {
  rmSync(join(paths.skills, "how-slaude-works"), { recursive: true, force: true });
  rmSync(join(paths.skills, ".bundled.json"), { force: true });
});

beforeEach(() => {
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

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

  test("a copy seeded before the manifest is refreshed only when it predates the memory rename and nobody stamped it", () => {
    const legacy = "---\nname: how-slaude-works\n---\nCheck `kb_search`, or `kb_think`; record with `kb_memoize`.\n";
    const md = join(paths.skills, "how-slaude-works", "SKILL.md");
    mkdirSync(join(paths.skills, "how-slaude-works"), { recursive: true });
    writeFileSync(md, legacy, "utf8");
    expect(seedBundledSkills().refreshed).toContain("how-slaude-works");
    expect(readFileSync(md, "utf8")).toContain("memory_search");
    // The replaced text is kept beside it.
    expect(readFileSync(join(paths.skills, "how-slaude-works", "SKILL.md.orig"), "utf8")).toBe(legacy);

    // write_skill edited it (authored_by stamp): left alone, old names and all.
    rmSync(join(paths.skills, ".bundled.json"), { force: true });
    const stamped = legacy.replace("---\n", "---\nauthored_by: \"agent\"\n");
    writeFileSync(md, stamped, "utf8");
    expect(seedBundledSkills().refreshed).not.toContain("how-slaude-works");
    expect(readFileSync(md, "utf8")).toBe(stamped);
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
