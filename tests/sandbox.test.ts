import { afterEach, describe, expect, test } from "bun:test";
import { __probeSandbox, jailSandboxOptions, __resetSandboxCache } from "../src/agent/sandbox";

afterEach(() => __resetSandboxCache());

describe("__probeSandbox", () => {
  test("darwin → available (sandbox-exec built in)", () => {
    expect(__probeSandbox("darwin", () => false)).toBe(true);
  });
  test("linux with bwrap → available", () => {
    expect(__probeSandbox("linux", (bin) => bin === "bwrap")).toBe(true);
  });
  test("linux without bwrap → unavailable", () => {
    expect(__probeSandbox("linux", () => false)).toBe(false);
  });
});

describe("jailSandboxOptions", () => {
  test("locks bash: enabled, no unsandboxed escape, deny-all egress", () => {
    const o = jailSandboxOptions([]);
    expect(o.enabled).toBe(true);
    expect(o.allowUnsandboxedCommands).toBe(false);
    expect(o.autoAllowBashIfSandboxed).toBe(true);
    expect(o.network?.allowedDomains).toEqual([]);
  });
  test("passes through allowed domains", () => {
    expect(jailSandboxOptions(["pkg.dev"]).network?.allowedDomains).toEqual(["pkg.dev"]);
  });
});
