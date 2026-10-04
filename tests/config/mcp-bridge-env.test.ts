import { afterEach, describe, expect, test } from "bun:test";
import { env, mcpBridgeEnvViolations } from "../../src/config/env";

const NAMES = {
  timeoutMs: "SLAUDE_MCP_BRIDGE_TIMEOUT_MS",
  ownerConcurrency: "SLAUDE_MCP_BRIDGE_OWNER_CONCURRENCY",
  maxRequestBytes: "SLAUDE_MCP_BRIDGE_MAX_REQUEST_BYTES",
  maxResultBytes: "SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES",
  sessionConcurrency: "SLAUDE_MCP_BRIDGE_SESSION_CONCURRENCY",
  idleMs: "SLAUDE_MCP_BRIDGE_IDLE_MS",
  maxListBytes: "SLAUDE_MCP_BRIDGE_MAX_LIST_BYTES",
  maxTools: "SLAUDE_MCP_BRIDGE_MAX_TOOLS",
} as const;
const saved = Object.fromEntries(Object.values(NAMES).map((n) => [n, process.env[n]]));
afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

describe("SLAUDE_MCP_BRIDGE_* limits", () => {
  test("defaults", () => {
    for (const n of Object.values(NAMES)) delete process.env[n];
    expect({
      timeoutMs: env.mcpBridge.timeoutMs(),
      ownerConcurrency: env.mcpBridge.ownerConcurrency(),
      maxRequestBytes: env.mcpBridge.maxRequestBytes(),
      maxResultBytes: env.mcpBridge.maxResultBytes(),
      sessionConcurrency: env.mcpBridge.sessionConcurrency(),
      idleMs: env.mcpBridge.idleMs(),
      maxListBytes: env.mcpBridge.maxListBytes(),
      maxTools: env.mcpBridge.maxTools(),
    }).toEqual({
      timeoutMs: 50_000, ownerConcurrency: 8, maxRequestBytes: 1024 * 1024, maxResultBytes: 1024 * 1024,
      sessionConcurrency: 4, idleMs: 300_000, maxListBytes: 1024 * 1024, maxTools: 500,
    });
  });

  test("a positive integer is taken; an empty value is the default", () => {
    process.env[NAMES.timeoutMs] = "20000";
    process.env[NAMES.ownerConcurrency] = " ";
    expect(env.mcpBridge.timeoutMs()).toBe(20_000);
    expect(env.mcpBridge.ownerConcurrency()).toBe(8);
  });

  test("the boot check names every malformed bridge variable, and passes a clean environment", () => {
    expect(mcpBridgeEnvViolations({})).toEqual([]);
    expect(mcpBridgeEnvViolations({ SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG: "1", SLAUDE_MCP_BRIDGE_ENV_ALLOW: "EXAMPLE_A, EXAMPLE_B", SLAUDE_MCP_BRIDGE_MAX_TOOLS: "10" })).toEqual([]);
    const bad = mcpBridgeEnvViolations({
      SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG: "true",
      SLAUDE_MCP_BRIDGE_ENV_ALLOW: "ok_NAME,lower",
      SLAUDE_MCP_BRIDGE_IDLE_MS: "5m",
      SLAUDE_MCP_BRIDGE_TIMEOUT_MS: "0",
    });
    expect(bad).toEqual([
      "SLAUDE_MCP_BRIDGE_TIMEOUT_MS must be a positive integer (got '0')",
      "SLAUDE_MCP_BRIDGE_IDLE_MS must be a positive integer (got '5m')",
      "SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG must be 0 or 1 (got 'true')",
      "SLAUDE_MCP_BRIDGE_ENV_ALLOW entries must be variable names (A-Z, 0-9, _): 'ok_NAME'",
      "SLAUDE_MCP_BRIDGE_ENV_ALLOW entries must be variable names (A-Z, 0-9, _): 'lower'",
    ]);
  });

  test("anything else is refused, naming the variable", () => {
    for (const bad of ["0", "-1", "1.5", "50s", "lots"]) {
      process.env[NAMES.maxResultBytes] = bad;
      expect(() => env.mcpBridge.maxResultBytes()).toThrow(/SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES must be a positive integer/);
    }
  });
});
