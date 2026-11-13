import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { AGENT_SCHEMA_FILE, AGENT_SCHEMA_URL, agentSchemaText, buildAgentJsonSchema } from "../../scripts/gen-agent-schema";
import { CORPUS, CORPUS_DIR } from "./agent-corpus";
import { parseAgentYaml } from "../../src/persona/agent-def";

describe("docs/site/schemas/agent.schema.json", () => {
  test("the committed file is what the Zod schema generates, so a schema change always changes a file under docs/** and republishes (run `bun run schema:agent`)", () => {
    expect(readFileSync(AGENT_SCHEMA_FILE, "utf8")).toBe(agentSchemaText());
  });

  test("it is published under the docs site's schemas path", () => {
    expect(buildAgentJsonSchema().$id).toBe(AGENT_SCHEMA_URL);
    expect(AGENT_SCHEMA_URL).toBe("https://barockok.github.io/slaude/schemas/agent.schema.json");
  });

  test("every field carries help text for the editor", () => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const props = o.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [k, v] of Object.entries(props ?? {})) {
        if (typeof v.description !== "string" || !v.description) missing.push(`${path}${k}`);
        walk(v, `${path}${k}.`);
        for (const m of (v.anyOf as unknown[] | undefined) ?? []) walk(m, `${path}${k}.`);
        walk(v.items, `${path}${k}[].`);
      }
    };
    walk(buildAgentJsonSchema(), "");
    expect(missing).toEqual([]);
  });

  test("unknown keys fail at every level", () => {
    const json = JSON.stringify(buildAgentJsonSchema());
    // One additionalProperties:false per object: top, mandate, scoped entry, access, approver, access.channels, memory, proactive, channel entry.
    expect(json.match(/"additionalProperties":false/g)?.length).toBe(9);
  });
});

describe("JSON Schema parity with the validator (ajv)", () => {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: false });
  const validate = ajv.compile(buildAgentJsonSchema());

  for (const c of CORPUS) {
    if (c.ok) {
      test(`accepted by both: ${c.id}`, () => {
        expect(() => parseAgentYaml(CORPUS_DIR, c.yaml)).not.toThrow();
        expect(validate(parse(c.yaml))).toBe(true);
      });
    } else if (c.shape) {
      test(`shape-invalid fails in both: ${c.id}`, () => {
        expect(() => parseAgentYaml(CORPUS_DIR, c.yaml)).toThrow();
        expect(validate(parse(c.yaml))).toBe(false);
      });
    }
  }

  test("repeated skills and guardrails are flagged in the editor too", () => {
    expect(validate({ name: "a", soul: "x", skills: ["a", "a"] })).toBe(false);
    expect(validate({ name: "a", soul: "x", guardrails: ["a", "a"] })).toBe(false);
  });
});
