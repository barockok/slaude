import { describe, it, expect, afterEach } from "bun:test";
import { env } from "../../src/config/env";

describe("cluster env", () => {
  afterEach(() => {
    delete process.env.SLAUDE_CLUSTER;
    delete process.env.SLAUDE_REDIS_URL;
    delete process.env.SLAUDE_INSTANCE_ID;
    delete process.env.SLAUDE_LEASE_TTL_SECONDS;
  });

  it("disabled by default; on for 1/true/yes", () => {
    delete process.env.SLAUDE_CLUSTER;
    expect(env.cluster.enabled()).toBe(false);
    for (const v of ["1", "true", "YES"]) {
      process.env.SLAUDE_CLUSTER = v;
      expect(env.cluster.enabled()).toBe(true);
    }
    process.env.SLAUDE_CLUSTER = "nope";
    expect(env.cluster.enabled()).toBe(false);
  });

  it("redisUrl required only when read", () => {
    delete process.env.SLAUDE_REDIS_URL;
    expect(() => env.cluster.redisUrl()).toThrow();
    process.env.SLAUDE_REDIS_URL = "redis://localhost:6379";
    expect(env.cluster.redisUrl()).toBe("redis://localhost:6379");
  });

  it("instanceId falls back to hostname when unset", () => {
    delete process.env.SLAUDE_INSTANCE_ID;
    expect(env.cluster.instanceId().length).toBeGreaterThan(0);
    process.env.SLAUDE_INSTANCE_ID = "worker-7";
    expect(env.cluster.instanceId()).toBe("worker-7");
  });

  it("leaseTtlSeconds defaults to 900, overridable, bad value falls back", () => {
    delete process.env.SLAUDE_LEASE_TTL_SECONDS;
    expect(env.cluster.leaseTtlSeconds()).toBe(900);
    process.env.SLAUDE_LEASE_TTL_SECONDS = "60";
    expect(env.cluster.leaseTtlSeconds()).toBe(60);
    process.env.SLAUDE_LEASE_TTL_SECONDS = "not-a-number";
    expect(env.cluster.leaseTtlSeconds()).toBe(900);
  });
});
