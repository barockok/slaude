/**
 * One predicate decides which variables no subprocess may hold
 * (isChildScrubbedEnv): the agent child's environment, the node manifest's
 * env and placeholders, and `.mcp.json` `${VAR}` expansion on the gateway all
 * use it, so the lists cannot drift. The brain's embedding provider keys are
 * on it: the brain runs in the gateway process, and nothing in the agent
 * child needs them.
 */
import { describe, expect, test } from "bun:test";
import { isChildScrubbedEnv, scrubChildEnv } from "../../src/agent/child-env";
import { GATEWAY_ONLY_ENV_NAMES } from "../../src/config/gateway-only-env";
import { EMBEDDING_PROVIDER_KEY_ENV } from "../../src/knowledge/embedding-keys";
import { parseExternalMcp } from "../../src/gateway/core/external-mcp";

const EMBEDDING_KEYS = Object.values(EMBEDDING_PROVIDER_KEY_ENV).filter((k): k is string => !!k);

describe("the child-scrub list is the single source", () => {
  test("covers every key the brain reads for an embedding provider (the exact set, so it cannot drift)", () => {
    expect(EMBEDDING_KEYS.sort()).toEqual([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "MINIMAX_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "VOYAGE_API_KEY",
      "ZEROENTROPY_API_KEY",
    ]);
    for (const k of EMBEDDING_KEYS) expect(isChildScrubbedEnv(k)).toBe(true);
  });

  test("the mono agent child never receives an embedding key", () => {
    const env = Object.fromEntries(EMBEDDING_KEYS.map((k) => [k, "fake-embedding-key"]));
    expect(scrubChildEnv({ ...env, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  test(".mcp.json expansion refuses every child-scrubbed name, not only the gateway-only ones", () => {
    const names = [...GATEWAY_ONLY_ENV_NAMES, ...EMBEDDING_KEYS, "SLAUDE_NODE_TOKEN", "SLAUDE_REDIS_URL", "SLAUDE_ENCRYPTION_KEY", "PERSONA_X", "VAULT_TOKEN"];
    for (const n of names) expect(isChildScrubbedEnv(n)).toBe(true);
    const env = Object.fromEntries(names.map((n) => [n, `value-of-${n}`]));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const out = parseExternalMcp(
        { mcpServers: { s: { command: "run", env: Object.fromEntries(names.map((n) => [n, `\${${n}}`])), args: names.map((n) => `\${${n}}`) } } },
        { ...env, OK_VALUE: "fine" },
      );
      const s = out.servers.s as { env: Record<string, string>; args: string[] };
      for (const n of names) {
        expect(s.env[n]).toBe(`\${${n}}`);
        expect(s.args).toContain(`\${${n}}`);
      }
    } finally {
      console.warn = warn;
    }
  });
});
