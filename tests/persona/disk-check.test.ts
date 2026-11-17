import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { checkDiskPersonas, soulOnlyPersonas, STARTER_AGENT_YAML } from "../../src/persona/disk-check";
import { readFileAgent } from "../../src/persona/file-agent";
import { validateSoul } from "../../src/soul/validate";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "disk-check-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const put = (rel: string, text: string) => {
  const f = join(home, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
};

describe("the starter agent.yaml", () => {
  test("compiles, and says what is missing before going live", () => {
    const { spec } = parseAgentYaml("default", STARTER_AGENT_YAML);
    expect(spec.name).toBe("default");
    put("agent.yaml", STARTER_AGENT_YAML);
    const a = readFileAgent(home, "default")!;
    const r = validateSoul(a.soulJson, a.soulMd);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("manager.userId");
  });
});

describe("checkDiskPersonas", () => {
  test("a bare home gets the starter, once", () => {
    expect(checkDiskPersonas(home).seeded).toBe(join(home, "agent.yaml"));
    expect(readFileSync(join(home, "agent.yaml"), "utf8")).toBe(STARTER_AGENT_YAML);
    expect(checkDiskPersonas(home)).toEqual({});
  });

  test("a SOUL.md with no agent.yaml stops, naming the persona and the command", () => {
    put("SOUL.md", "# old");
    expect(() => checkDiskPersonas(home)).toThrow(/'default'.*personas migrate/s);
    expect(existsSync(join(home, "agent.yaml"))).toBe(false);
  });

  test("a named persona with only a SOUL.md stops too, and the default does not hide it", () => {
    put("agent.yaml", "name: default\nsoul: x\n");
    put("personas/sam/SOUL.md", "# old");
    put("personas/ok/agent.yaml", "name: ok\nsoul: x\n");
    expect(soulOnlyPersonas(home)).toEqual(["sam"]);
    expect(() => checkDiskPersonas(home)).toThrow(/'sam'/);
  });

  test("a home with an agent.yaml is left alone", () => {
    put("agent.yaml", "name: default\nsoul: x\n");
    expect(checkDiskPersonas(home)).toEqual({});
  });
});
