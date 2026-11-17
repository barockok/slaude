import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../src/redact";
import { isChildScrubbedEnv, scrubChildEnv } from "../../src/agent/child-env";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

const NAME = "SLAUDE_DECISION_API_KEY";

describe("SLAUDE_DECISION_API_KEY stays in the gateway", () => {
  test("a log line or error text that carries it is masked, as an assignment and as a key shape", () => {
    expect(redactSecrets(`${NAME}=decision-secret-value`)).not.toContain("decision-secret-value");
    expect(redactSecrets(`x-api-key: decision-secret-value`)).not.toContain("decision-secret-value");
    expect(redactSecrets("failed with sk-ant-api03-abcdefghijkl")).not.toContain("abcdefghijkl");
  });
  test("it is a gateway-only name: the agent child scrub and the node boot check treat it so", () => {
    expect(isGatewayOnlyEnv(NAME)).toBe(true);
    expect(isChildScrubbedEnv(NAME)).toBe(true);
    const out = scrubChildEnv({ [NAME]: "v", PATH: "/bin" });
    expect(out[NAME]).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });
  test("nothing under src/node mentions it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js)$/.test(f) && /SLAUDE_DECISION_API_KEY|decisionApiKey/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(join(import.meta.dir, "../../src/node"));
    expect(hits).toEqual([]);
  });
  test("only the config module and the anthropic adapter read it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && /decisionApiKey|process\.env\.SLAUDE_DECISION_API_KEY/.test(readFileSync(p, "utf8"))) hits.push(p.replace(/.*\/src\//, "src/"));
      }
    };
    walk(join(import.meta.dir, "../../src"));
    expect(hits.sort()).toEqual(["src/config/env.ts", "src/decision/adapters/anthropic.ts"]);
  });
});
