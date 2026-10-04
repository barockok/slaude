import { describe, it, expect } from "bun:test";
import { scrubChildEnv } from "../../src/agent/child-env";
import { GATEWAY_ONLY_ENV_NAMES, GATEWAY_ONLY_ENV_PREFIXES } from "../../src/config/gateway-only-env";

describe("scrubChildEnv", () => {
  it("removes SLAUDE_ENCRYPTION_KEY from the env passed to the SDK child", () => {
    const out = scrubChildEnv({ FOO: "1", SLAUDE_ENCRYPTION_KEY: "secret" });
    expect(out.FOO).toBe("1");
    expect(out.SLAUDE_ENCRYPTION_KEY).toBeUndefined();
  });

  // The agent child must hold no credential that writes persona state or
  // speaks for the gateway: in mono the child is the node, and its Bash tool
  // could otherwise POST to /deploy or post as another persona.
  it("removes the deploy tokens, the gateway secrets and every PERSONA_* variable", () => {
    const out = scrubChildEnv({
      KEEP: "yes",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "provider-key",
      SLAUDE_DEPLOY_TOKEN: "d".repeat(40),
      SLAUDE_DEPLOY_PREVIEW_TOKEN: "p".repeat(40),
      SLAUDE_MASTER_KEY: "m".repeat(44),
      SLAUDE_NODE_TOKEN: "n".repeat(40),
      SLAUDE_JOB_SECRET: "j".repeat(40),
      PERSONA_SUPPORT_XOXP: "user-token",
      PERSONA_SUPPORT_GITHUB_AUTHORIZATION: "Bearer abc",
      PERSONA_: "edge",
    });
    expect(out).toEqual({ KEEP: "yes", PATH: "/usr/bin", ANTHROPIC_API_KEY: "provider-key" });
  });

  it("keeps variables that only resemble the stripped names", () => {
    const out = scrubChildEnv({ MY_PERSONA_X: "1", SLAUDE_DEPLOY_TOKENS: "2", persona_lower: "3" });
    expect(out).toEqual({ MY_PERSONA_X: "1", SLAUDE_DEPLOY_TOKENS: "2", persona_lower: "3" });
  });

  it("does not mutate its input", () => {
    const input = { SLAUDE_MASTER_KEY: "k", PERSONA_A_XOXP: "t" };
    scrubChildEnv(input);
    expect(input).toEqual({ SLAUDE_MASTER_KEY: "k", PERSONA_A_XOXP: "t" });
  });
});

describe("scrubChildEnv and the gateway-only list", () => {
  it("strips every gateway-only name and prefix, the single list the node boot check uses", () => {
    const input: Record<string, string> = { KEEP: "yes", ANTHROPIC_BASE_URL: "https://llm.example.com" };
    for (const n of GATEWAY_ONLY_ENV_NAMES) input[n] = "fake";
    for (const p of GATEWAY_ONLY_ENV_PREFIXES) input[`${p}SOMETHING`] = "fake";
    const out = scrubChildEnv(input);
    expect(out).toEqual({ KEEP: "yes", ANTHROPIC_BASE_URL: "https://llm.example.com" });
  });

  // The node process needs Redis; the agent child does not, and Redis holds
  // every session's queue, locks and event stream.
  it("strips SLAUDE_REDIS_URL, which only the node process needs", () => {
    expect(scrubChildEnv({ SLAUDE_REDIS_URL: "redis://r", KEEP: "1" })).toEqual({ KEEP: "1" });
  });

  it("strips the database URLs, Slack secrets, node keys and Vault variables by name", () => {
    const out = scrubChildEnv({
      SLAUDE_PG_URL: "postgres://u:p@h/db",
      SLAUDE_BRAIN_DATABASE_URL: "postgres://u:p@h/brain",
      SLACK_SIGNING_SECRET: "s",
      SLACK_CLIENT_SECRET: "c",
      SLACK_BOT_TOKEN: "b",
      SLAUDE_OAUTH_STATE_SECRET: "o",
      SLAUDE_NODE_KEY: "k",
      SLAUDE_NODE_KEY_PREVIOUS: "kp",
      SLAUDE_NODE_LEGACY_TOKEN: "l",
      SLAUDE_VAULT_ADDR: "https://vault.example.com",
      VAULT_TOKEN: "v",
    });
    expect(out).toEqual({});
  });
});
