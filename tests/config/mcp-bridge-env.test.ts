import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";

const NAMES = {
  timeoutMs: "SLAUDE_MCP_BRIDGE_TIMEOUT_MS",
  ownerConcurrency: "SLAUDE_MCP_BRIDGE_OWNER_CONCURRENCY",
  maxRequestBytes: "SLAUDE_MCP_BRIDGE_MAX_REQUEST_BYTES",
  maxResultBytes: "SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES",
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
    }).toEqual({ timeoutMs: 50_000, ownerConcurrency: 8, maxRequestBytes: 1024 * 1024, maxResultBytes: 1024 * 1024 });
  });

  test("a positive integer is taken; an empty value is the default", () => {
    process.env[NAMES.timeoutMs] = "20000";
    process.env[NAMES.ownerConcurrency] = " ";
    expect(env.mcpBridge.timeoutMs()).toBe(20_000);
    expect(env.mcpBridge.ownerConcurrency()).toBe(8);
  });

  test("anything else is refused, naming the variable", () => {
    for (const bad of ["0", "-1", "1.5", "50s", "lots"]) {
      process.env[NAMES.maxResultBytes] = bad;
      expect(() => env.mcpBridge.maxResultBytes()).toThrow(/SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES must be a positive integer/);
    }
  });
});
