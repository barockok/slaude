import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { env, __resetDeployTokenWarnings } from "../../src/config/env";
import { scrubChildEnv } from "../../src/agent/child-env";
import { nodeBootCheck } from "../../src/config/gateway-only-env";

const KEYS = ["SLAUDE_BRAIN_IMPORT_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY_TOKEN"];
let saved: Record<string, string | undefined> = {};
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  __resetDeployTokenWarnings();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("SLAUDE_BRAIN_IMPORT_TOKEN", () => {
  test("trimmed; blank, under 32 characters, or equal to a node credential is unset", () => {
    expect(env.brainImportToken()).toBe("");
    process.env.SLAUDE_BRAIN_IMPORT_TOKEN = "  " + "b".repeat(40) + " ";
    expect(env.brainImportToken()).toBe("b".repeat(40));
    process.env.SLAUDE_BRAIN_IMPORT_TOKEN = "b".repeat(31);
    expect(env.brainImportToken()).toBe("");
    process.env.SLAUDE_BRAIN_IMPORT_TOKEN = "b".repeat(40);
    process.env.SLAUDE_NODE_TOKEN = "b".repeat(40);
    expect(env.brainImportToken()).toBe("");
  });
  test("the agent child never inherits it and a node refuses to boot with it", () => {
    expect(scrubChildEnv({ SLAUDE_BRAIN_IMPORT_TOKEN: "x".repeat(40), KEEP: "1" })).toEqual({ KEEP: "1" });
    expect(JSON.stringify(nodeBootCheck({ SLAUDE_BRAIN_IMPORT_TOKEN: "x".repeat(40) } as any))).toContain("SLAUDE_BRAIN_IMPORT_TOKEN");
  });
});
