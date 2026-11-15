import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ENVIRONMENT_SCHEMA_FILE, buildEnvironmentJsonSchema, environmentSchemaText } from "../../../scripts/gen-agent-schema";
import { ENVIRONMENT_SCHEMA_URL } from "../../../src/remote/definitions/schema";
import { parseEnvironmentYaml } from "../../../src/remote/definitions/parse";

const FP = "SHA256:" + "A".repeat(43);
const good = `name: team-sandbox\nkind: ssh\nshared: true\ntrust: unlocked\ndefaultDir: /srv/work\nssh:\n  host: build-box.example.com\n  user: dev\n  hostKey: "${FP}"\n`;

describe("docs/site/schemas/environment.schema.json", () => {
  test("the committed file is what the Zod schema generates (run `bun run schema:agent`)", () => {
    expect(readFileSync(ENVIRONMENT_SCHEMA_FILE, "utf8")).toBe(environmentSchemaText());
  });

  test("it is published under the docs site's schemas path", () => {
    expect(buildEnvironmentJsonSchema().$id).toBe(ENVIRONMENT_SCHEMA_URL);
    expect(ENVIRONMENT_SCHEMA_URL).toBe("https://barockok.github.io/slaude/schemas/environment.schema.json");
  });

  test("every field carries help text", () => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string) => {
      const props = (node as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
      for (const [k, v] of Object.entries(props ?? {})) {
        if (typeof v.description !== "string" || !v.description) missing.push(`${path}${k}`);
        walk(v, `${path}${k}.`);
      }
    };
    walk(buildEnvironmentJsonSchema(), "");
    expect(missing).toEqual([]);
  });

  test("unknown keys fail at both levels, and the validator agrees with ajv", () => {
    const json = JSON.stringify(buildEnvironmentJsonSchema());
    expect(json.match(/"additionalProperties":false/g)?.length).toBe(2);
    const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(buildEnvironmentJsonSchema());
    expect(validate(parse(good))).toBe(true);
    expect(() => parseEnvironmentYaml("team-sandbox", good)).not.toThrow();
    for (const bad of [good.replace("shared: true\n", ""), good + "extra: 1\n", good.replace(`  hostKey: "${FP}"\n`, ""), good.replace("kind: ssh", "kind: tailcat")]) {
      expect(validate(parse(bad))).toBe(false);
      expect(() => parseEnvironmentYaml("team-sandbox", bad)).toThrow();
    }
  });
});
