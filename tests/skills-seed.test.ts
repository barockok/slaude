import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { seedBundledSkills } from "../src/skills/seed";

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
});
