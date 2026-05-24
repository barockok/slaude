import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { env } from "../src/config/env";

describe("env helpers", () => {
  const orig = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete (process.env as any)[k];
    for (const [k, v] of Object.entries(orig)) (process.env as any)[k] = v;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete (process.env as any)[k];
    for (const [k, v] of Object.entries(orig)) (process.env as any)[k] = v;
  });

  test("req throws when missing", () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(() => env.slack.botToken()).toThrow(/missing env/);
  });

  test("opt falls back", () => {
    delete process.env.SLAUDE_MODEL;
    expect(env.model()).toBe("");
  });

  test("approvers splits comma list", () => {
    process.env.SLAUDE_APPROVERS = "U1, U2 ,U3";
    expect(env.slack.approvers()).toEqual(["U1", "U2", "U3"]);
  });

  test("provider helpers", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    process.env.ANTHROPIC_BASE_URL = "url";
    process.env.ANTHROPIC_AUTH_TOKEN = "auth";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    expect(env.provider.apiKey()).toBe("key");
    expect(env.provider.baseUrl()).toBe("url");
    expect(env.provider.authToken()).toBe("auth");
    expect(env.provider.oauthToken()).toBe("oauth");
  });

  test("defaultPermissionMode normalizes aliases", () => {
    process.env.SLAUDE_DEFAULT_MODE = "yolo";
    expect(env.defaultPermissionMode()).toBe("bypassPermissions");
    process.env.SLAUDE_DEFAULT_MODE = "ask";
    expect(env.defaultPermissionMode()).toBe("default");
    process.env.SLAUDE_DEFAULT_MODE = "accept-edits";
    expect(env.defaultPermissionMode()).toBe("acceptEdits");
    process.env.SLAUDE_DEFAULT_MODE = "plan";
    expect(env.defaultPermissionMode()).toBe("plan");
    process.env.SLAUDE_DEFAULT_MODE = "dont-ask";
    expect(env.defaultPermissionMode()).toBe("dontAsk");
    delete process.env.SLAUDE_DEFAULT_MODE;
    expect(env.defaultPermissionMode()).toBe("default");
  });

  test("idleMs converts minutes to ms", () => {
    process.env.SLAUDE_IDLE_MINUTES = "10";
    expect(env.idleMs()).toBe(10 * 60 * 1000);
    delete process.env.SLAUDE_IDLE_MINUTES;
    expect(env.idleMs()).toBe(15 * 60 * 1000);
  });

  test("autoEvolve enabled by default", () => {
    delete process.env.SLAUDE_AUTO_EVOLVE;
    expect(env.autoEvolve()).toBe(true);
    process.env.SLAUDE_AUTO_EVOLVE = "0";
    expect(env.autoEvolve()).toBe(false);
  });

  test("skillsRepo", () => {
    process.env.SLAUDE_SKILLS_REPO = "github:foo/bar";
    expect(env.skillsRepo()).toBe("github:foo/bar");
  });

  test("tokenWarnPct defaults", () => {
    delete process.env.SLAUDE_TOKEN_WARN_PCT;
    expect(env.tokenWarnPct()).toBe(0.8);
    process.env.SLAUDE_TOKEN_WARN_PCT = "0.5";
    expect(env.tokenWarnPct()).toBe(0.5);
  });

  test("tokenCriticalPct edge cases", () => {
    delete process.env.SLAUDE_TOKEN_CRITICAL_PCT;
    expect(env.tokenCriticalPct()).toBe(0.92);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "0";
    expect(env.tokenCriticalPct()).toBe(0);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "1.5";
    expect(env.tokenCriticalPct()).toBe(0.92);
  });

  test("tokenFallbackContextWindow", () => {
    delete process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW;
    expect(env.tokenFallbackContextWindow()).toBe(200_000);
    process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW = "1000000";
    expect(env.tokenFallbackContextWindow()).toBe(1_000_000);
  });

  test("metricsLabels", () => {
    process.env.SLAUDE_METRICS_LABELS = "a=1,b=2";
    expect(env.metricsLabels()).toBe("a=1,b=2");
  });

  test("metricsPerUser", () => {
    delete process.env.SLAUDE_METRICS_PER_USER;
    expect(env.metricsPerUser()).toBe(false);
    process.env.SLAUDE_METRICS_PER_USER = "true";
    expect(env.metricsPerUser()).toBe(true);
    process.env.SLAUDE_METRICS_PER_USER = "1";
    expect(env.metricsPerUser()).toBe(true);
    process.env.SLAUDE_METRICS_PER_USER = "yes";
    expect(env.metricsPerUser()).toBe(true);
  });
});
