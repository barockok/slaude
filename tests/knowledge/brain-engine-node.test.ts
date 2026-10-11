import { afterEach, describe, expect, test } from "bun:test";
import { brainEngineConfig, closeBrain, getBrain } from "../../src/knowledge/brain";
import { NodeDbAccessError } from "../../src/db/client";

const KEYS = ["SLAUDE_ROLE", "SLAUDE_BRAIN_ENGINE", "SLAUDE_BRAIN_DATABASE_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// The brain's default PGLite lives on the shared volume and is single-writer:
// a node opening it would be a second writer next to the gateway.
describe("brainEngineConfig in the node role", () => {
  test("refuses the embedded PGLite engine", () => {
    process.env.SLAUDE_ROLE = "node";
    delete process.env.SLAUDE_BRAIN_ENGINE;
    expect(() => brainEngineConfig()).toThrow(NodeDbAccessError);
  });

  test("postgres without a URL still fails, as before", () => {
    process.env.SLAUDE_ROLE = "node";
    process.env.SLAUDE_BRAIN_ENGINE = "postgres";
    delete process.env.SLAUDE_BRAIN_DATABASE_URL;
    expect(() => brainEngineConfig()).toThrow(/SLAUDE_BRAIN_DATABASE_URL/);
  });

  test("other roles keep PGLite", () => {
    process.env.SLAUDE_ROLE = "mono";
    delete process.env.SLAUDE_BRAIN_ENGINE;
    expect(brainEngineConfig().engine).toBe("pglite");
  });
});

// A refused boot must not be cached: a later call, under different
// configuration, retries instead of replaying the first failure.
describe("getBrain after a failed boot", () => {
  test("retries with the current configuration", async () => {
    await closeBrain(); // an earlier file in this process may have booted one
    process.env.SLAUDE_ROLE = "node";
    delete process.env.SLAUDE_BRAIN_ENGINE;
    await expect(getBrain()).rejects.toThrow(NodeDbAccessError);
    process.env.SLAUDE_ROLE = "mono";
    process.env.SLAUDE_BRAIN_ENGINE = "postgres";
    delete process.env.SLAUDE_BRAIN_DATABASE_URL;
    await expect(getBrain()).rejects.toThrow(/SLAUDE_BRAIN_DATABASE_URL/);
  });
});
