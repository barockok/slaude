import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { makeSkillHandlers, skillOps } from "../../src/skills/mcp-tools";
import { personaSkillsRoot } from "../../src/skills/loader";

const REFUSAL = "`skill-authoring` is a built-in skill and cannot be changed at runtime";
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
});

describe("built-in skills are immutable at runtime", () => {
  test("write_skill refuses a built-in name", async () => {
    const r = await makeSkillHandlers().write_skill({
      slug: "skill-authoring", name: "x", description: "y", body: "z",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    expect(existsSync(join(paths.skills, "skill-authoring"))).toBe(false);
  });

  test("delete_skill refuses a built-in name", async () => {
    mkdirSync(join(paths.skills, "skill-authoring"), { recursive: true });
    const r = await makeSkillHandlers().delete_skill({ slug: "skill-authoring" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    expect(existsSync(join(paths.skills, "skill-authoring"))).toBe(true);
  });

  test("persona overlay cannot shadow a built-in", async () => {
    const h = makeSkillHandlers("some-persona");
    const w = await h.write_skill({ slug: "skill-authoring", name: "x", description: "y", body: "z" });
    expect(w.isError).toBe(true);
    expect(text(w)).toBe(REFUSAL);
    expect(existsSync(join(personaSkillsRoot("some-persona"), "skill-authoring"))).toBe(false);
    const d = await h.delete_skill({ slug: "skill-authoring" });
    expect(d.isError).toBe(true);
    expect(text(d)).toBe(REFUSAL);
  });

  test("skillOps itself refuses, so no other caller can bypass the handlers", () => {
    expect(() => skillOps.write("skill-authoring", "x", "y", "z")).toThrow(REFUSAL);
    expect(() => skillOps.delete("skill-authoring")).toThrow(REFUSAL);
  });

  test("other slugs still work", async () => {
    const h = makeSkillHandlers();
    const w = await h.write_skill({ slug: "my-skill", name: "n", description: "d", body: "b" });
    expect(w.isError).toBeUndefined();
    expect(existsSync(join(paths.skills, "my-skill", "SKILL.md"))).toBe(true);
    const d = await h.delete_skill({ slug: "my-skill" });
    expect(d.isError).toBeUndefined();
    expect(existsSync(join(paths.skills, "my-skill"))).toBe(false);
  });
});
