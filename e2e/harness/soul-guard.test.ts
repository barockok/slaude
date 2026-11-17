import { expect, test } from "bun:test";
import { STARTER_AGENT_YAML } from "../../src/persona/disk-check";
import { classifySoul, seedRefusal, STARTER_MARKERS } from "./in-pod/soul-guard";

// The exact text the gateway writes to a bare home: STARTER_AGENT_YAML, imported from where it lives.
const STARTER = STARTER_AGENT_YAML;
const SEED = { SLAUDE_E2E_SEED: "1" };
const FILE = "/data/agent.yaml";

test("the gateway's untouched starter agent.yaml is recognised, and every marker comes from it", () => {
  for (const m of STARTER_MARKERS) expect(STARTER).toContain(m);
  expect(classifySoul(STARTER)).toBe("starter");
  expect(seedRefusal("starter", SEED, FILE)).toBeNull();
});

test("an operator's file is refused unless forced, even one that kept some placeholders", () => {
  const edited = STARTER.replace('description: "<one line, what this agent is for>"', "description: release bot");
  expect(classifySoul(edited)).toBe("operator");
  expect(classifySoul("name: default\nsoul: x\n")).toBe("operator");
  expect(classifySoul(`# Notes\n${STARTER.replace("# The default persona. Fill in who manages it", "# Other")}`)).toBe("operator");
  expect(seedRefusal("operator", SEED, FILE)).toMatch(/^refusing to replace \/data\/agent\.yaml: .*SLAUDE_E2E_SEED_FORCE=1/);
  expect(seedRefusal("operator", { ...SEED, SLAUDE_E2E_SEED_FORCE: "1" }, FILE)).toBeNull();
});

test("an e2e file (Persona-ID line) is replaceable, even when built on the starter", () => {
  expect(classifySoul("name: default\nsoul: |\n  Sim agent.\n  Persona-ID: alpha\n")).toBe("e2e");
  expect(classifySoul(`${STARTER}\nPersona-ID: alpha\n`)).toBe("e2e");
  expect(seedRefusal("e2e", SEED, FILE)).toBeNull();
});

test("an absent agent.yaml is replaceable, and nothing runs without SLAUDE_E2E_SEED=1", () => {
  expect(classifySoul(null)).toBe("absent");
  expect(seedRefusal("absent", SEED, FILE)).toBeNull();
  for (const kind of ["absent", "e2e", "starter", "operator"] as const) {
    expect(seedRefusal(kind, {}, FILE)).toBe("refusing to run: set SLAUDE_E2E_SEED=1 (this overwrites agent.yaml)");
    expect(seedRefusal(kind, { SLAUDE_E2E_SEED: "true", SLAUDE_E2E_SEED_FORCE: "1" }, "/x")).toMatch(/^refusing to run/);
  }
});
