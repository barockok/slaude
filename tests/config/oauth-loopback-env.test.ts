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
});
