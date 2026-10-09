/**
 * Voice env readers: SLAUDE_VOICE_TENANTS tenant isolation (PF49).
 */
import { describe, it, expect, afterEach } from "bun:test";

const { env } = await import("../../src/config/env");

afterEach(() => {
  delete process.env.SLAUDE_VOICE_TENANTS;
});

describe("env.voice.tenants", () => {
  it("unset or empty returns empty list", () => {
    expect(env.voice.tenants()).toEqual([]);
    process.env.SLAUDE_VOICE_TENANTS = "";
    expect(env.voice.tenants()).toEqual([]);
    process.env.SLAUDE_VOICE_TENANTS = "   ";
    expect(env.voice.tenants()).toEqual([]);
  });

  it("* returns the wildcard", () => {
    process.env.SLAUDE_VOICE_TENANTS = "*";
    expect(env.voice.tenants()).toBe("*");
  });

  it("parses comma-separated tenant ids with trimming", () => {
    process.env.SLAUDE_VOICE_TENANTS = "t1,t2,t3";
    expect(env.voice.tenants()).toEqual(["t1", "t2", "t3"]);

    process.env.SLAUDE_VOICE_TENANTS = "  t1  ,  t2  ";
    expect(env.voice.tenants()).toEqual(["t1", "t2"]);
  });

  it("drops empty entries", () => {
    process.env.SLAUDE_VOICE_TENANTS = "t1,,t2";
    expect(env.voice.tenants()).toEqual(["t1", "t2"]);

    process.env.SLAUDE_VOICE_TENANTS = ",t1,";
    expect(env.voice.tenants()).toEqual(["t1"]);
  });
});
