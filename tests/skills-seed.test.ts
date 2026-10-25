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
