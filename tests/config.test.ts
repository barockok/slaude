import { describe, expect, test, beforeEach } from "bun:test";
import { paths, ensureHome, SLAUDE_HOME } from "../src/config/home";
import { env } from "../src/config/env";
import { existsSync } from "node:fs";

describe("config/home", () => {
  test("paths derived under SLAUDE_HOME", () => {
    expect(paths.home).toBe(SLAUDE_HOME);
    expect(paths.soul.startsWith(SLAUDE_HOME)).toBe(true);
    expect(paths.skills.startsWith(SLAUDE_HOME)).toBe(true);
  });
  test("ensureHome creates dirs (idempotent)", () => {
    ensureHome();
    expect(existsSync(paths.home)).toBe(true);
    expect(existsSync(paths.skills)).toBe(true);
    expect(existsSync(paths.workspaces)).toBe(true);
    ensureHome();
  });
});

describe("config/env dotenv loader", () => {
  test("seeded .env values reachable on process.env", () => {
    expect(process.env.SLAUDE_TEST_QUOTED).toBe("hello");
    expect(process.env.SLAUDE_TEST_SINGLE).toBe("world");
    expect(process.env.SLAUDE_TEST_PLAIN).toBe("plain");
  });
});

describe("config/env getters", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.SLAUDE_APPROVERS;
    delete process.env.SLACK_ALLOWED_USERS;
    delete process.env.SLAUDE_DEFAULT_MODE;
    delete process.env.SLAUDE_IDLE_MINUTES;
    delete process.env.SLAUDE_MODEL;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  test("req() throws when env missing", () => {
    expect(() => env.slack.botToken()).toThrow(/missing env/);
    expect(() => env.slack.appToken()).toThrow(/missing env/);
  });

  test("provider getters use opt fallback", () => {
    expect(env.provider.apiKey()).toBe("");
    expect(env.provider.baseUrl()).toBe("");
    expect(env.provider.authToken()).toBe("");
    expect(env.provider.oauthToken()).toBe("");
    expect(env.model()).toBe("");
  });

  test("populated getters", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-T";
    process.env.SLACK_APP_TOKEN = "xapp-T";
    process.env.SLAUDE_APPROVERS = "U9, U10";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_BASE_URL = "u";
    process.env.ANTHROPIC_AUTH_TOKEN = "t";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-abc";
    process.env.SLAUDE_MODEL = "x";
    expect(env.slack.botToken()).toBe("xoxb-T");
    expect(env.slack.appToken()).toBe("xapp-T");
    expect(env.slack.approvers()).toEqual(["U9", "U10"]);
    expect(env.provider.apiKey()).toBe("k");
    expect(env.provider.baseUrl()).toBe("u");
    expect(env.provider.authToken()).toBe("t");
    expect(env.provider.oauthToken()).toBe("sk-ant-oat01-abc");
    expect(env.model()).toBe("x");
  });

  test("idleMs valid + invalid + zero", () => {
    process.env.SLAUDE_IDLE_MINUTES = "30";
    expect(env.idleMs()).toBe(30 * 60 * 1000);
    process.env.SLAUDE_IDLE_MINUTES = "abc";
    expect(env.idleMs()).toBe(15 * 60 * 1000);
    process.env.SLAUDE_IDLE_MINUTES = "0";
    expect(env.idleMs()).toBe(0);
    delete process.env.SLAUDE_IDLE_MINUTES;
    expect(env.idleMs()).toBe(15 * 60 * 1000);
  });

  test.each([
    ["ask", "default"],
    ["accept-edits", "acceptEdits"],
    ["acceptedits", "acceptEdits"],
    ["edits", "acceptEdits"],
    ["plan", "plan"],
    ["yolo", "bypassPermissions"],
    ["bypass", "bypassPermissions"],
    ["bypasspermissions", "bypassPermissions"],
    ["dont-ask", "dontAsk"],
    ["dontask", "dontAsk"],
    ["deny", "dontAsk"],
    ["default", "default"],
    ["wat", "default"],
  ])("default mode %s → %s", (raw, expected) => {
    process.env.SLAUDE_DEFAULT_MODE = raw;
    expect(env.defaultPermissionMode()).toBe(expected);
  });

  test("default mode env unset → default", () => {
    delete process.env.SLAUDE_DEFAULT_MODE;
    expect(env.defaultPermissionMode()).toBe("default");
  });

  test("empty approvers → []", () => {
    expect(env.slack.approvers()).toEqual([]);
  });

  test("tokenWarnPct default + valid + invalid + out-of-range", () => {
    delete process.env.SLAUDE_TOKEN_WARN_PCT;
    expect(env.tokenWarnPct()).toBe(0.8);
    process.env.SLAUDE_TOKEN_WARN_PCT = "0.5";
    expect(env.tokenWarnPct()).toBe(0.5);
    process.env.SLAUDE_TOKEN_WARN_PCT = "abc";
    expect(env.tokenWarnPct()).toBe(0.8);
    process.env.SLAUDE_TOKEN_WARN_PCT = "0";
    expect(env.tokenWarnPct()).toBe(0.8);
    process.env.SLAUDE_TOKEN_WARN_PCT = "1";
    expect(env.tokenWarnPct()).toBe(0.8);
    delete process.env.SLAUDE_TOKEN_WARN_PCT;
  });

  test("tokenCriticalPct default + 0 disables + invalid + range clamp", () => {
    delete process.env.SLAUDE_TOKEN_CRITICAL_PCT;
    expect(env.tokenCriticalPct()).toBe(0.92);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "0";
    expect(env.tokenCriticalPct()).toBe(0);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "0.95";
    expect(env.tokenCriticalPct()).toBe(0.95);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "abc";
    expect(env.tokenCriticalPct()).toBe(0.92);
    process.env.SLAUDE_TOKEN_CRITICAL_PCT = "1.5";
    expect(env.tokenCriticalPct()).toBe(0.92);
    delete process.env.SLAUDE_TOKEN_CRITICAL_PCT;
  });

  test("metricsLabels passthrough", () => {
    delete process.env.SLAUDE_METRICS_LABELS;
    expect(env.metricsLabels()).toBe("");
    process.env.SLAUDE_METRICS_LABELS = "a=1,b=2";
    expect(env.metricsLabels()).toBe("a=1,b=2");
    delete process.env.SLAUDE_METRICS_LABELS;
  });
  test("metricsPerUser parses truthy/falsy", () => {
    delete process.env.SLAUDE_METRICS_PER_USER;
    expect(env.metricsPerUser()).toBe(false);
    for (const v of ["1", "true", "yes", "TRUE", "Yes"]) {
      process.env.SLAUDE_METRICS_PER_USER = v;
      expect(env.metricsPerUser()).toBe(true);
    }
    process.env.SLAUDE_METRICS_PER_USER = "0";
    expect(env.metricsPerUser()).toBe(false);
    process.env.SLAUDE_METRICS_PER_USER = "no";
    expect(env.metricsPerUser()).toBe(false);
    delete process.env.SLAUDE_METRICS_PER_USER;
  });
  test("tokenFallbackContextWindow default + override + invalid", () => {
    delete process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW;
    expect(env.tokenFallbackContextWindow()).toBe(200_000);
    process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW = "1000000";
    expect(env.tokenFallbackContextWindow()).toBe(1_000_000);
    process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW = "abc";
    expect(env.tokenFallbackContextWindow()).toBe(200_000);
    process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW = "0";
    expect(env.tokenFallbackContextWindow()).toBe(200_000);
    process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW = "-5";
    expect(env.tokenFallbackContextWindow()).toBe(200_000);
    delete process.env.SLAUDE_FALLBACK_CONTEXT_WINDOW;
  });
});
