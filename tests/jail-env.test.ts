import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../src/config/env";

const orig = { ...process.env };
afterEach(() => {
  process.env = { ...orig };
});

describe("env.jailMode", () => {
  test("defaults to discipline", () => {
    delete process.env.SLAUDE_JAIL_MODE;
    expect(env.jailMode()).toBe("discipline");
  });
  test("parses off and adversarial", () => {
    process.env.SLAUDE_JAIL_MODE = "off";
    expect(env.jailMode()).toBe("off");
    process.env.SLAUDE_JAIL_MODE = "adversarial";
    expect(env.jailMode()).toBe("adversarial");
  });
  test("unknown value falls back to discipline", () => {
    process.env.SLAUDE_JAIL_MODE = "wat";
    expect(env.jailMode()).toBe("discipline");
  });
});

describe("env.jailBashNetwork", () => {
  test("default: no domains", () => {
    delete process.env.SLAUDE_JAIL_BASH_NETWORK;
    expect(env.jailBashNetwork()).toEqual([]);
  });
  test("parses comma list", () => {
    process.env.SLAUDE_JAIL_BASH_NETWORK = "api.example.com, pkg.dev";
    expect(env.jailBashNetwork()).toEqual(["api.example.com", "pkg.dev"]);
  });
});
