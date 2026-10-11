import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySoul, seedRefusal, STARTER_MARKERS } from "./in-pod/soul-guard";

// The exact text the gateway writes to an absent SOUL.md: STARTER_PERSONA from the loader
// source, evaluated the way the template literal is (it has no ${} and only escaped backticks).
function starterFromLoader(): string {
  const src = readFileSync(join(import.meta.dir, "../../src/soul/loader.ts"), "utf8");
  const start = src.indexOf("const STARTER_PERSONA = `");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start + "const STARTER_PERSONA = `".length);
  const end = body.search(/(?<!\\)`;/);
  expect(end).toBeGreaterThan(0);
  const raw = body.slice(0, end);
  expect(raw).not.toContain("${");
  return raw.replace(/\\`/g, "`");
}

const STARTER = starterFromLoader();
const SEED = { SLAUDE_E2E_SEED: "1" };

test("the gateway's untouched starter persona is recognised, and every marker comes from the loader", () => {
  for (const m of STARTER_MARKERS) expect(STARTER).toContain(m);
  expect(classifySoul(STARTER)).toBe("starter");
  expect(seedRefusal("starter", SEED, "/data/SOUL.md")).toBeNull();
});

test("an operator's soul is refused unless forced, even one that kept some placeholders", () => {
  const edited = STARTER.replace("- Name: <agent display name>", "- Name: Jane Doe");
  expect(classifySoul(edited)).toBe("operator");
  expect(classifySoul("# Persona\n\n## Identity\n- Name: Release Bot\n")).toBe("operator");
  expect(classifySoul(`# Notes\n${STARTER}`)).toBe("operator");
  expect(seedRefusal("operator", SEED, "/data/SOUL.md")).toMatch(/^refusing to replace \/data\/SOUL\.md: .*SLAUDE_E2E_SEED_FORCE=1/);
  expect(seedRefusal("operator", { ...SEED, SLAUDE_E2E_SEED_FORCE: "1" }, "/data/SOUL.md")).toBeNull();
});

test("an e2e soul (Persona-ID line) is replaceable, even when built on the starter", () => {
  expect(classifySoul("# Persona\n- Manager: U0MGR\n\nPersona-ID: alpha\n")).toBe("e2e");
  expect(classifySoul(`${STARTER}\nPersona-ID: alpha\n`)).toBe("e2e");
  expect(seedRefusal("e2e", SEED, "/data/SOUL.md")).toBeNull();
});

test("an absent SOUL.md is replaceable, and nothing runs without SLAUDE_E2E_SEED=1", () => {
  expect(classifySoul(null)).toBe("absent");
  expect(seedRefusal("absent", SEED, "/data/SOUL.md")).toBeNull();
  for (const kind of ["absent", "e2e", "starter", "operator"] as const) {
    expect(seedRefusal(kind, {}, "/data/SOUL.md")).toBe("refusing to run: set SLAUDE_E2E_SEED=1 (this overwrites SOUL.md)");
    expect(seedRefusal(kind, { SLAUDE_E2E_SEED: "true", SLAUDE_E2E_SEED_FORCE: "1" }, "/x")).toMatch(/^refusing to run/);
  }
});
