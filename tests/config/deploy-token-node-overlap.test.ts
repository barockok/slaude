/**
 * The /deploy credentials must never equal a credential every node holds. A
 * legacy node holds the gateway's SLAUDE_NODE_LEGACY_TOKEN (as its own
 * SLAUDE_NODE_TOKEN), so a deploy or preview token equal to it is unset, the
 * same as one equal to SLAUDE_NODE_TOKEN.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { env, __resetDeployTokenWarnings } from "../../src/config/env";

const KEYS = ["SLAUDE_DEPLOY_TOKEN", "SLAUDE_DEPLOY_PREVIEW_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY_TOKEN"];
const SHARED = "x".repeat(40);
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
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("deploy tokens vs node credentials", () => {
  test("a deploy token equal to SLAUDE_NODE_LEGACY_TOKEN is unset, with one warning naming no value", () => {
    process.env.SLAUDE_NODE_LEGACY_TOKEN = SHARED;
    process.env.SLAUDE_DEPLOY_TOKEN = SHARED;
    expect(env.deployToken()).toBe("");
    expect(env.deployToken()).toBe("");
    const hits = warn.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("SLAUDE_DEPLOY_TOKEN"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("SLAUDE_NODE_LEGACY_TOKEN");
    expect(hits[0]).not.toContain(SHARED);
  });

  test("a preview token equal to SLAUDE_NODE_LEGACY_TOKEN is unset", () => {
    process.env.SLAUDE_NODE_LEGACY_TOKEN = SHARED;
    process.env.SLAUDE_DEPLOY_TOKEN = "d".repeat(40);
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = SHARED;
    expect(env.deployPreviewToken()).toBe("");
    expect(env.deployToken()).toBe("d".repeat(40));
  });

  test("still unset when equal to SLAUDE_NODE_TOKEN; distinct tokens are kept", () => {
    process.env.SLAUDE_NODE_TOKEN = SHARED;
    process.env.SLAUDE_DEPLOY_TOKEN = SHARED;
    expect(env.deployToken()).toBe("");
    process.env.SLAUDE_NODE_LEGACY_TOKEN = "l".repeat(40);
    process.env.SLAUDE_DEPLOY_TOKEN = "d".repeat(40);
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = "p".repeat(40);
    expect(env.deployToken()).toBe("d".repeat(40));
    expect(env.deployPreviewToken()).toBe("p".repeat(40));
  });
});
