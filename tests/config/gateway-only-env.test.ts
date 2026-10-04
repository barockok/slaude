import { describe, expect, test } from "bun:test";
import {
  GATEWAY_ONLY_ENV_NAMES,
  GATEWAY_ONLY_ENV_PREFIXES,
  gatewayOnlyEnvPresent,
  isGatewayOnlyEnv,
  nodeBootCheck,
} from "../../src/config/gateway-only-env";

describe("the gateway-only variable list", () => {
  test("names every secret only the gateway may hold, including those later features add", () => {
    for (const name of [
      "SLAUDE_MASTER_KEY",
      "SLAUDE_JOB_SECRET",
      "SLAUDE_NODE_KEY",
      "SLAUDE_NODE_KEY_PREVIOUS",
      "SLAUDE_NODE_LEGACY_TOKEN",
      "SLAUDE_PG_URL",
      "SLAUDE_BRAIN_DATABASE_URL",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_USER_TOKEN",
      "SLAUDE_OAUTH_STATE_SECRET",
      "SLAUDE_DEPLOY_TOKEN",
      "SLAUDE_DEPLOY_PREVIEW_TOKEN",
      "SLAUDE_PANEL_SECRET",
      "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
      "SLAUDE_BRAIN_TOKEN",
      "EMBEDDING_API_KEY",
      "LITELLM_API_KEY",
    ]) {
      expect(GATEWAY_ONLY_ENV_NAMES).toContain(name);
      expect(isGatewayOnlyEnv(name)).toBe(true);
    }
    expect(GATEWAY_ONLY_ENV_PREFIXES).toEqual(expect.arrayContaining(["SLAUDE_VAULT_", "VAULT_", "PERSONA_"]));
    expect(isGatewayOnlyEnv("SLAUDE_VAULT_ADDR")).toBe(true);
    expect(isGatewayOnlyEnv("VAULT_TOKEN")).toBe(true);
    expect(isGatewayOnlyEnv("PERSONA_SUPPORT_XOXP")).toBe(true);
  });

  test("leaves out what a node legitimately holds", () => {
    for (const name of [
      "SLAUDE_NODE_TOKEN",
      "SLAUDE_REDIS_URL",
      "SLAUDE_GATEWAY_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "SLACK_CLIENT_ID",
      "MY_PERSONA_X",
      "SLAUDE_DEPLOY_TOKENS",
      "persona_lower",
    ]) {
      expect(isGatewayOnlyEnv(name)).toBe(false);
    }
  });

  test("gatewayOnlyEnvPresent returns sorted names and ignores empty values", () => {
    expect(
      gatewayOnlyEnvPresent({
        SLAUDE_REDIS_URL: "redis://redis:6379",
        SLAUDE_PG_URL: "postgres://u:p@h/db",
        SLAUDE_MASTER_KEY: "fake-master",
        PERSONA_A_XOXP: "fake",
        SLAUDE_JOB_SECRET: "",
        SLACK_BOT_TOKEN: undefined,
      }),
    ).toEqual(["PERSONA_A_XOXP", "SLAUDE_MASTER_KEY", "SLAUDE_PG_URL"]);
  });
});

describe("nodeBootCheck", () => {
  const leaky = { SLAUDE_NODE_TOKEN: "fake-node", SLAUDE_MASTER_KEY: "fake-master-value", SLAUDE_JOB_SECRET: "fake-job-value" };

  test("a clean environment passes in every mode", () => {
    for (const mode of [undefined, "warn", "refuse"]) {
      const env: Record<string, string> = { SLAUDE_NODE_TOKEN: "fake-node", SLAUDE_REDIS_URL: "redis://r" };
      if (mode) env.SLAUDE_NODE_BOOT_CHECK = mode;
      expect(nodeBootCheck(env)).toEqual({ action: "ok", mode: mode === "refuse" ? "refuse" : "warn", names: [] });
    }
  });

  test("defaults to warn: names the variables and lets the boot continue", () => {
    const r = nodeBootCheck(leaky);
    expect(r.action).toBe("warn");
    expect(r.mode).toBe("warn");
    expect(r.names).toEqual(["SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY"]);
    expect(r.message).toContain("SLAUDE_JOB_SECRET");
    expect(r.message).toContain("SLAUDE_MASTER_KEY");
  });

  test("refuse stops the boot", () => {
    const r = nodeBootCheck({ ...leaky, SLAUDE_NODE_BOOT_CHECK: "refuse" });
    expect(r.action).toBe("refuse");
    expect(r.names).toEqual(["SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY"]);
    expect(r.message).toContain("SLAUDE_NODE_ALLOW_GATEWAY_SECRETS");
  });

  test("SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1 downgrades refuse to warn", () => {
    const r = nodeBootCheck({ ...leaky, SLAUDE_NODE_BOOT_CHECK: "refuse", SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "1" });
    expect(r.action).toBe("warn");
    expect(r.mode).toBe("refuse");
    expect(r.names).toEqual(["SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY"]);
  });

  test("an unknown mode is treated as the default, warn", () => {
    expect(nodeBootCheck({ ...leaky, SLAUDE_NODE_BOOT_CHECK: "nonsense" }).action).toBe("warn");
    expect(nodeBootCheck({ ...leaky, SLAUDE_NODE_BOOT_CHECK: " REFUSE " }).action).toBe("refuse");
  });

  test("the message carries names only, never a value", () => {
    for (const env of [leaky, { ...leaky, SLAUDE_NODE_BOOT_CHECK: "refuse" }]) {
      const msg = nodeBootCheck(env).message ?? "";
      expect(msg).not.toContain("fake-master-value");
      expect(msg).not.toContain("fake-job-value");
      expect(msg).not.toContain("fake-node");
    }
  });
});
