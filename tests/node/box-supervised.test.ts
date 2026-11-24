/**
 * The node's supervised box wiring, the parts that need no supervisor: where a
 * boxed session's provider credential comes from (and that it is never taken
 * from the node when the bundle is strict), which hosts a box never reaches,
 * and which CLI a box may run.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildEnvPatch } from "../../src/agent/child-env";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { cliDirs, nodeServiceHosts, providerRouteOf } from "../../src/node/box-supervised";
import { ScratchDirs } from "../../src/node/scratch";

describe("a boxed session's provider route", () => {
  const node = { ANTHROPIC_API_KEY: "the-node-own-key", ANTHROPIC_BASE_URL: "https://node-provider.example.com" };

  test("the bundle's credential and base URL, one form", () => {
    expect(providerRouteOf({ ANTHROPIC_API_KEY: "persona-key", ANTHROPIC_BASE_URL: "https://provider.example.com/v1x" }, {})).toEqual({ baseUrl: "https://provider.example.com/v1x", form: "api-key", credential: "persona-key" });
    expect(providerRouteOf({ ANTHROPIC_AUTH_TOKEN: "persona-token" }, {})).toEqual({ baseUrl: "https://api.anthropic.com", form: "auth-token", credential: "persona-token" });
    expect(providerRouteOf({ CLAUDE_CODE_OAUTH_TOKEN: "persona-oauth" }, {})).toEqual({ baseUrl: "https://api.anthropic.com", form: "oauth-token", credential: "persona-oauth" });
  });

  test("several forms: one is chosen, and it is the form the box's placeholder will be in", () => {
    expect(providerRouteOf({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, {}).form).toBe("api-key");
    expect(providerRouteOf({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_AUTH_TOKEN: "t" }, {}).form).toBe("auth-token");
  });

  test("an additive overlay falls back to the node's own provider variables, as an unboxed child would", () => {
    expect(providerRouteOf(undefined, node)).toEqual({ baseUrl: "https://node-provider.example.com", form: "api-key", credential: "the-node-own-key" });
    expect(providerRouteOf({ SLAUDE_AGENT_ID: "agent" }, node).credential).toBe("the-node-own-key");
  });

  test("a strict overlay never takes the node's: the persona's key, or no route at all", () => {
    expect(providerRouteOf(new ChildEnvPatch({ ANTHROPIC_AUTH_TOKEN: "persona-token" }, ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]), node)).toEqual({ baseUrl: "https://api.anthropic.com", form: "auth-token", credential: "persona-token" });
    expect(() => providerRouteOf(new ChildEnvPatch({}, ["ANTHROPIC_API_KEY"]), node)).toThrow(BootFailure);
  });

  test("no credential anywhere is a boot failure that names no value", () => {
    let err: unknown;
    try {
      providerRouteOf({ ANTHROPIC_BASE_URL: "https://provider.example.com" }, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootFailure);
    expect((err as BootFailure).code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
  });
});

describe("what a box never reaches", () => {
  test("the gateway, Redis and the object store, by host name, with no credential kept", () => {
    const hosts = nodeServiceHosts({
      SLAUDE_GATEWAY_URL: "http://Gateway.internal.example:8080/",
      SLAUDE_REDIS_URL: "redis://:a-redis-password@redis.internal.example:6379/0",
      SLAUDE_S3_ENDPOINT: "https://objects.internal.example",
    });
    expect(hosts.sort()).toEqual(["gateway.internal.example", "objects.internal.example", "redis.internal.example"]);
    expect(hosts.join(",")).not.toContain("a-redis-password");
  });
  test("nothing set, or something that is not a URL, refuses nothing by name", () => {
    expect(nodeServiceHosts({})).toEqual([]);
    expect(nodeServiceHosts({ SLAUDE_S3_ENDPOINT: "::: not a url" })).toEqual([]);
  });
});

describe("the CLI a box may run", () => {
  test("only the SDK's own platform packages that hold a claude binary", () => {
    const dirs = cliDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      expect(d).toMatch(/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+$/);
      expect(statSync(join(d, "claude")).isFile()).toBe(true);
    }
  });
});

describe("scratch directories on a node that runs boxes", () => {
  test("live under the given parent, which is created", () => {
    const parent = join(mkdtempSync(join(tmpdir(), "slaude-scratch-parent-")), "box", "scratch");
    try {
      const s = new ScratchDirs({ parent, owners: [10001] });
      const dir = s.ensure("sess-1");
      expect(dir.startsWith(parent)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(s.pathFor("sess-1")).toBe(dir);
      s.removeAll();
    } finally {
      rmSync(join(parent, "..", ".."), { recursive: true, force: true });
    }
  });
});
