import { describe, it, expect } from "bun:test";
import { scrubChildEnv } from "../../src/agent/child-env";

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
