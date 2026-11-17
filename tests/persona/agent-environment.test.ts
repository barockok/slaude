import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { PayloadError, parsePayload, payloadVersionFor, SUPPORTED_PAYLOAD_VERSION } from "../../src/persona/sync/payload";

const agent = (env: string) => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${env}`;
const compile = (env: string) => parseAgentYaml("ana", agent(env));
function refusal(env: string): string {
  try {
    compile(env);
  } catch (e) {
    expect(e).toBeInstanceOf(PayloadError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("agent.yaml environment key", () => {
  test("allow only: stored by name, no default", () => {
    const c = compile("environment:\n  allow: [env:team-sandbox, env:other]\n");
    expect(c.spec.definition.environment).toEqual({ allow: ["team-sandbox", "other"] });
  });

  test("default is parsed and stored (not applied: nothing else changes)", () => {
    const c = compile("environment:\n  allow: [env:team-sandbox]\n  default: env:team-sandbox\n");
    expect(c.spec.definition.environment).toEqual({ allow: ["team-sandbox"], default: "team-sandbox" });
  });

  test("without the key the compiled spec has no environment", () => {
    expect("environment" in compile("").spec.definition).toBe(false);
  });

  test("only env:<name> references: bare names, other types, upper case and long names are refused", () => {
    for (const bad of ["mybox", "agent:mybox", "user:mybox", "node:mybox", "env:Team", "env:" + "a".repeat(42), "env:", "env:-x", "slack:user:U0EXAMPLE"]) {
      const m = refusal(`environment:\n  allow: ["${bad}"]\n`);
      expect(m).toContain("environment.allow[0]");
      expect(m).toContain("environment reference");
      if (bad.length > 5 && !"env:".startsWith(bad)) expect(m).not.toContain(bad);
    }
    expect(compile(`environment:\n  allow: ["env:${"a".repeat(41)}"]\n`).spec.definition.environment?.allow[0]).toBe("a".repeat(41));
  });

  test("a bad default is refused the same way", () => {
    expect(refusal("environment:\n  allow: [env:a]\n  default: bare\n")).toContain("environment.default");
  });

  test("inline configuration gets the inline-config message, without the value", () => {
    for (const key of ["kind: ssh", "host: build-box.example.com", "ssh: {host: x}", "config: {a: b}", "secrets: {a: b}"]) {
      const m = refusal(`environment:\n  allow: [env:a]\n  ${key}\n`);
      expect(m).toContain("environment configuration cannot be written in agent.yaml");
      expect(m).toContain("environments/<name>.yaml");
      expect(m).not.toContain("build-box");
    }
  });

  test("allow is required, 1 to 16, no repeats; default must be allowed", () => {
    expect(refusal("environment: {}\n")).toContain("environment.allow is required");
    expect(refusal("environment:\n  allow: []\n")).toContain("at least one");
    const seventeen = Array.from({ length: 17 }, (_, i) => `env:e${i}`).join(", ");
    expect(refusal(`environment:\n  allow: [${seventeen}]\n`)).toContain("more than 16");
    const sixteen = Array.from({ length: 16 }, (_, i) => `env:e${i}`).join(", ");
    expect(compile(`environment:\n  allow: [${sixteen}]\n`).spec.definition.environment?.allow).toHaveLength(16);
    expect(refusal("environment:\n  allow: [env:a, env:a]\n")).toContain("environment.allow[1] repeats");
    expect(refusal("environment:\n  allow: [env:a]\n  default: env:b\n")).toContain("environment.default must be one of");
  });

  test("payload version: 6 when unused, 7 when used, and a version 6 payload still parses", () => {
    const plain = compile("").spec;
    const used = compile("environment:\n  allow: [env:a]\n").spec;
    expect(SUPPORTED_PAYLOAD_VERSION).toBe(7);
    expect(payloadVersionFor([plain])).toBe(6);
    expect(payloadVersionFor([used])).toBe(7);
    expect(payloadVersionFor([plain], [], [])).toBe(7);
    const body = (version: number, p: object) => ({ version, revision: "r1", committedAt: "2026-10-01T10:00:00Z", personas: [p] });
    expect(parsePayload(body(6, plain)).version).toBe(6);
    const p7 = parsePayload(body(7, used));
    expect(p7.personas[0]!.definition?.environment).toEqual({ allow: ["a"] });
    expect(() => parsePayload(body(8, used))).toThrow(/newer/);
  });
});
