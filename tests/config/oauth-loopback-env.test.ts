import { describe, it, expect } from "bun:test";
import { env } from "../../src/config/env";

describe("oauth loopback env", () => {
  it("host defaults to 127.0.0.1, overridable", () => {
    delete process.env.SLAUDE_OAUTH_LOOPBACK_HOST;
    expect(env.oauthLoopbackHost()).toBe("127.0.0.1");
    process.env.SLAUDE_OAUTH_LOOPBACK_HOST = "0.0.0.0";
    expect(env.oauthLoopbackHost()).toBe("0.0.0.0");
    delete process.env.SLAUDE_OAUTH_LOOPBACK_HOST;
  });

  it("port range parses 'a-b'; empty when unset", () => {
    delete process.env.SLAUDE_OAUTH_LOOPBACK_PORTS;
    expect(env.oauthLoopbackPorts()).toEqual([]);
    process.env.SLAUDE_OAUTH_LOOPBACK_PORTS = "40100-40102";
    expect(env.oauthLoopbackPorts()).toEqual([40100, 40101, 40102]);
    delete process.env.SLAUDE_OAUTH_LOOPBACK_PORTS;
  });

  it("shared loopback off by default; on for 1/true/yes", () => {
    delete process.env.SLAUDE_OAUTH_SHARED_LOOPBACK;
    expect(env.oauthSharedLoopback()).toBe(false);
    for (const v of ["1", "true", "YES"]) {
      process.env.SLAUDE_OAUTH_SHARED_LOOPBACK = v;
      expect(env.oauthSharedLoopback()).toBe(true);
    }
    process.env.SLAUDE_OAUTH_SHARED_LOOPBACK = "nope";
    expect(env.oauthSharedLoopback()).toBe(false);
    delete process.env.SLAUDE_OAUTH_SHARED_LOOPBACK;
  });

  it("shared loopback port defaults to 3118, overridable, bad value → 3118", () => {
    delete process.env.SLAUDE_OAUTH_SHARED_LOOPBACK_PORT;
    expect(env.oauthSharedLoopbackPort()).toBe(3118);
    process.env.SLAUDE_OAUTH_SHARED_LOOPBACK_PORT = "9000";
    expect(env.oauthSharedLoopbackPort()).toBe(9000);
    process.env.SLAUDE_OAUTH_SHARED_LOOPBACK_PORT = "xyz";
    expect(env.oauthSharedLoopbackPort()).toBe(3118);
    delete process.env.SLAUDE_OAUTH_SHARED_LOOPBACK_PORT;
  });

  it("state secret: env value wins; empty → stable random per process", () => {
    process.env.SLAUDE_OAUTH_STATE_SECRET = "explicit";
    expect(env.oauthStateSecret()).toBe("explicit");
    delete process.env.SLAUDE_OAUTH_STATE_SECRET;
    const a = env.oauthStateSecret();
    expect(a.length).toBeGreaterThan(20);
    expect(env.oauthStateSecret()).toBe(a); // stable across calls
  });

  it("public url: empty by default, trimmed when set", () => {
    delete process.env.SLAUDE_OAUTH_PUBLIC_URL;
    expect(env.oauthPublicUrl()).toBe("");
    process.env.SLAUDE_OAUTH_PUBLIC_URL = "  https://maria-hermes-uat.amartha.id  ";
    expect(env.oauthPublicUrl()).toBe("https://maria-hermes-uat.amartha.id");
    delete process.env.SLAUDE_OAUTH_PUBLIC_URL;
  });
});
