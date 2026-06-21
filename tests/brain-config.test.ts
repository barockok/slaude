import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  brainBearerEnv,
  brainMode,
  brainRemoteUrl,
  brainServerConfig,
} from "../src/knowledge/brain-config";

const KEYS = [
  "SLAUDE_BRAIN_MODE",
  "SLAUDE_BRAIN_URL",
  "SLAUDE_BRAIN_SERVER_PORT",
  "SLAUDE_BRAIN_SERVER_HOST",
  "SLAUDE_BRAIN_PUBLIC_URL",
  "SLAUDE_BRAIN_OIDC_ISSUER",
  "SLAUDE_BRAIN_OIDC_AUDIENCE",
  "SLAUDE_BRAIN_AUTH_DISABLED",
  "SLAUDE_BRAIN_TOKEN",
] as const;

describe("brain-config", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("mode defaults to local", () => {
    expect(brainMode()).toBe("local");
  });

  test("mode reads remote", () => {
    process.env.SLAUDE_BRAIN_MODE = "remote";
    expect(brainMode()).toBe("remote");
  });

  test("unknown mode falls back to local", () => {
    process.env.SLAUDE_BRAIN_MODE = "weird";
    expect(brainMode()).toBe("local");
  });

  test("brainRemoteUrl throws when remote and url unset", () => {
    process.env.SLAUDE_BRAIN_MODE = "remote";
    expect(() => brainRemoteUrl()).toThrow(/SLAUDE_BRAIN_URL/);
  });

  test("brainRemoteUrl returns url when set", () => {
    process.env.SLAUDE_BRAIN_URL = "https://brain.example/mcp";
    expect(brainRemoteUrl()).toBe("https://brain.example/mcp");
  });

  test("brainServerConfig defaults", () => {
    const c = brainServerConfig();
    expect(c.port).toBe(4319);
    expect(c.host).toBe("0.0.0.0");
    expect(c.authDisabled).toBe(false);
  });

  test("brainServerConfig reads env", () => {
    process.env.SLAUDE_BRAIN_SERVER_PORT = "5000";
    process.env.SLAUDE_BRAIN_SERVER_HOST = "127.0.0.1";
    process.env.SLAUDE_BRAIN_PUBLIC_URL = "https://brain.example";
    process.env.SLAUDE_BRAIN_OIDC_ISSUER = "https://kc.example/realms/r";
    process.env.SLAUDE_BRAIN_OIDC_AUDIENCE = "slaude-brain";
    process.env.SLAUDE_BRAIN_AUTH_DISABLED = "1";
    const c = brainServerConfig();
    expect(c.port).toBe(5000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.publicUrl).toBe("https://brain.example");
    expect(c.issuer).toBe("https://kc.example/realms/r");
    expect(c.audience).toBe("slaude-brain");
    expect(c.authDisabled).toBe(true);
  });

  test("brainBearerEnv reads token", () => {
    expect(brainBearerEnv()).toBeUndefined();
    process.env.SLAUDE_BRAIN_TOKEN = "tok";
    expect(brainBearerEnv()).toBe("tok");
  });
});
